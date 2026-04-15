package envoy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

// TLSMaterial holds PEM-encoded CA and per-domain leaf certificates.
type TLSMaterial struct {
	CACert []byte // PEM
	CAKey  []byte // PEM
	Certs  []DomainCert
}

// DomainCert holds a PEM-encoded certificate and key for a single domain.
type DomainCert struct {
	Domain string
	Cert   []byte // PEM
	Key    []byte // PEM
}

// GenerateTLS creates a self-signed CA and per-domain leaf certificates
// for Envoy MITM TLS interception. All keys are EC P-256.
func GenerateTLS(domains []string) (*TLSMaterial, error) {
	// 1. Generate CA key pair.
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating CA key: %w", err)
	}

	// 2. Create self-signed CA certificate.
	caSerial, err := randomSerial()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	caTemplate := &x509.Certificate{
		SerialNumber: caSerial,
		Subject: pkix.Name{
			CommonName: "Boilerhouse Proxy CA",
		},
		NotBefore:             now,
		NotAfter:              now.Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
	}

	caCertDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, fmt.Errorf("creating CA certificate: %w", err)
	}

	caCertPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caCertDER})

	caKeyDER, err := x509.MarshalECPrivateKey(caKey)
	if err != nil {
		return nil, fmt.Errorf("marshalling CA key: %w", err)
	}
	caKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: caKeyDER})

	// Parse the CA cert back for signing leaf certs.
	caCert, err := x509.ParseCertificate(caCertDER)
	if err != nil {
		return nil, fmt.Errorf("parsing CA certificate: %w", err)
	}

	// 3. Generate per-domain leaf certificates.
	var certs []DomainCert
	for _, domain := range domains {
		leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("generating leaf key for %s: %w", domain, err)
		}

		leafSerial, err := randomSerial()
		if err != nil {
			return nil, err
		}

		leafTemplate := &x509.Certificate{
			SerialNumber: leafSerial,
			Subject: pkix.Name{
				CommonName: domain,
			},
			DNSNames:              []string{domain},
			NotBefore:             now,
			NotAfter:              now.Add(365 * 24 * time.Hour),
			KeyUsage:              x509.KeyUsageDigitalSignature,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			BasicConstraintsValid: true,
			IsCA:                  false,
		}

		leafCertDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCert, &leafKey.PublicKey, caKey)
		if err != nil {
			return nil, fmt.Errorf("creating leaf certificate for %s: %w", domain, err)
		}

		leafCertPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafCertDER})

		leafKeyDER, err := x509.MarshalECPrivateKey(leafKey)
		if err != nil {
			return nil, fmt.Errorf("marshalling leaf key for %s: %w", domain, err)
		}
		leafKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: leafKeyDER})

		certs = append(certs, DomainCert{
			Domain: domain,
			Cert:   leafCertPEM,
			Key:    leafKeyPEM,
		})
	}

	return &TLSMaterial{
		CACert: caCertPEM,
		CAKey:  caKeyPEM,
		Certs:  certs,
	}, nil
}

// randomSerial generates a random serial number for X.509 certificates.
func randomSerial() (*big.Int, error) {
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return nil, fmt.Errorf("generating serial number: %w", err)
	}
	return serial, nil
}
