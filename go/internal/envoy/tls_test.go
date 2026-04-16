package envoy

import (
	"crypto/x509"
	"encoding/pem"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenerateTLS_ValidCerts(t *testing.T) {
	material, err := GenerateTLS([]string{"api.example.com"})
	require.NoError(t, err)

	// CA cert parses.
	caBlock, rest := pem.Decode(material.CACert)
	require.NotNil(t, caBlock, "CA cert should be valid PEM")
	assert.Empty(t, rest, "no extra PEM data after CA cert")
	assert.Equal(t, "CERTIFICATE", caBlock.Type)

	caCert, err := x509.ParseCertificate(caBlock.Bytes)
	require.NoError(t, err)
	assert.Equal(t, "Boilerhouse Proxy CA", caCert.Subject.CommonName)
	assert.True(t, caCert.IsCA)
	assert.True(t, caCert.BasicConstraintsValid)

	// CA key parses.
	caKeyBlock, _ := pem.Decode(material.CAKey)
	require.NotNil(t, caKeyBlock, "CA key should be valid PEM")
	assert.Equal(t, "EC PRIVATE KEY", caKeyBlock.Type)

	// Leaf cert.
	require.Len(t, material.Certs, 1)
	leaf := material.Certs[0]
	assert.Equal(t, "api.example.com", leaf.Domain)

	leafBlock, _ := pem.Decode(leaf.Cert)
	require.NotNil(t, leafBlock)
	leafCert, err := x509.ParseCertificate(leafBlock.Bytes)
	require.NoError(t, err)

	// Leaf is not a CA.
	assert.False(t, leafCert.IsCA)
	assert.Equal(t, "api.example.com", leafCert.Subject.CommonName)

	// Leaf has correct SAN.
	assert.Contains(t, leafCert.DNSNames, "api.example.com")

	// Leaf is signed by the CA.
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	opts := x509.VerifyOptions{
		Roots:     roots,
		DNSName:   "api.example.com",
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	_, err = leafCert.Verify(opts)
	require.NoError(t, err, "leaf cert should be verifiable against CA")

	// Leaf key parses.
	leafKeyBlock, _ := pem.Decode(leaf.Key)
	require.NotNil(t, leafKeyBlock)
	assert.Equal(t, "EC PRIVATE KEY", leafKeyBlock.Type)
}

func TestGenerateTLS_MultipleDomains(t *testing.T) {
	domains := []string{"api.openai.com", "api.anthropic.com", "hooks.slack.com"}
	material, err := GenerateTLS(domains)
	require.NoError(t, err)

	require.Len(t, material.Certs, 3)

	// Parse CA for verification.
	caBlock, _ := pem.Decode(material.CACert)
	require.NotNil(t, caBlock)
	caCert, err := x509.ParseCertificate(caBlock.Bytes)
	require.NoError(t, err)

	roots := x509.NewCertPool()
	roots.AddCert(caCert)

	for i, domain := range domains {
		t.Run(domain, func(t *testing.T) {
			dc := material.Certs[i]
			assert.Equal(t, domain, dc.Domain)

			leafBlock, _ := pem.Decode(dc.Cert)
			require.NotNil(t, leafBlock)
			leafCert, err := x509.ParseCertificate(leafBlock.Bytes)
			require.NoError(t, err)

			assert.Equal(t, domain, leafCert.Subject.CommonName)
			assert.Contains(t, leafCert.DNSNames, domain)

			// Verify against CA.
			opts := x509.VerifyOptions{
				Roots:     roots,
				DNSName:   domain,
				KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			}
			_, err = leafCert.Verify(opts)
			require.NoError(t, err, "leaf cert for %s should verify against CA", domain)
		})
	}

	// Each cert has a unique serial.
	serials := map[string]bool{}
	for _, dc := range material.Certs {
		block, _ := pem.Decode(dc.Cert)
		cert, _ := x509.ParseCertificate(block.Bytes)
		serial := cert.SerialNumber.String()
		assert.False(t, serials[serial], "serial numbers should be unique")
		serials[serial] = true
	}
}
