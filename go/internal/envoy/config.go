package envoy

import (
	"bytes"
	"strings"
	"text/template"
)

// ResolvedCredential holds a domain and its resolved HTTP headers.
type ResolvedCredential struct {
	Domain  string
	Headers map[string]string
}

// EnvoyConfig holds the inputs needed to generate an Envoy bootstrap YAML.
type EnvoyConfig struct {
	Allowlist   []string
	Credentials []ResolvedCredential
	TLS         *TLSMaterial // nil if no TLS interception needed
}

// SafeDomain replaces characters that are invalid in Envoy cluster/route names.
func SafeDomain(domain string) string {
	r := strings.NewReplacer(".", "_", "*", "_")
	return r.Replace(domain)
}

// GenerateEnvoyYAML renders the Envoy bootstrap configuration YAML.
func GenerateEnvoyYAML(cfg EnvoyConfig) (string, error) {
	funcMap := template.FuncMap{
		"safeDomain": SafeDomain,
	}

	tmpl, err := template.New("envoy").Funcs(funcMap).Parse(envoyTemplate)
	if err != nil {
		return "", err
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}

const envoyTemplate = `admin:
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 18081

static_resources:
  listeners:
    - name: egress_http
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 80
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: egress_http
                http_protocol_options:
                  allow_absolute_url: true
                route_config:
                  virtual_hosts:
{{- range .Credentials}}
                    - name: {{safeDomain .Domain}}
                      domains:
                        - "{{.Domain}}"
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: upstream_{{safeDomain .Domain}}
                            # LLM streaming responses can take minutes.
                            timeout: 600s
                          request_headers_to_add:
{{- range $key, $val := .Headers}}
                            - header:
                                key: "{{$key}}"
                                value: "{{$val}}"
                              append_action: OVERWRITE_IF_EXISTS_OR_ADD
{{- end}}
{{- end}}
                    - name: deny_all
                      domains:
                        - "*"
                      routes:
                        - match:
                            prefix: "/"
                          direct_response:
                            status: 403
                            body:
                              inline_string: "blocked by boilerhouse proxy"
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
{{- if .TLS}}
    - name: egress_tls
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 443
      listener_filters:
        - name: envoy.filters.listener.tls_inspector
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
      filter_chains:
{{- range .Credentials}}
        - filter_chain_match:
            server_names:
              - "{{.Domain}}"
          transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain:
                      filename: /etc/envoy/{{safeDomain .Domain}}.crt
                    private_key:
                      filename: /etc/envoy/{{safeDomain .Domain}}.key
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: egress_tls_{{safeDomain .Domain}}
                route_config:
                  virtual_hosts:
                    - name: {{safeDomain .Domain}}_tls
                      domains:
                        - "{{.Domain}}"
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: upstream_{{safeDomain .Domain}}
                            # LLM streaming responses can take minutes.
                            timeout: 600s
                          request_headers_to_add:
{{- range $key, $val := .Headers}}
                            - header:
                                key: "{{$key}}"
                                value: "{{$val}}"
                              append_action: OVERWRITE_IF_EXISTS_OR_ADD
{{- end}}
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
{{- end}}
{{- end}}

  clusters:
{{- range .Credentials}}
    - name: upstream_{{safeDomain .Domain}}
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      # Defaults (1024 per priority) are too tight when a single tenant
      # opens many concurrent / long-lived streaming requests.
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 65536
            max_pending_requests: 65536
            max_requests: 65536
            max_retries: 8
      load_assignment:
        cluster_name: upstream_{{safeDomain .Domain}}
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: {{.Domain}}
                      port_value: 443
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          sni: {{.Domain}}
{{- end}}
`
