#!/bin/bash

# Define variables
CA_KEY="ca-key.pem"
CA_CERT="ca-cert.pem"
SERVER_KEY="server-key.pem"
SERVER_CSR="server-csr.pem"
SERVER_CERT="server-cert.pem"
SERVER_EXT="server-ext.cnf"

DOMAIN="localhost"

# Create server config file for SAN
cat > $SERVER_EXT <<- EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
[req_distinguished_name]
[ v3_req ]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names
[alt_names]
DNS.1 = $DOMAIN
EOF

# Generate server key and CSR
openssl genrsa -out $SERVER_KEY 4096
openssl req -new -key $SERVER_KEY -out $SERVER_CSR -subj "/CN=$DOMAIN" -config $SERVER_EXT

# Sign the server CSR with the CA certificate to get the server certificate
openssl x509 -req -in $SERVER_CSR -CA $CA_CERT -CAkey $CA_KEY -CAcreateserial -out $SERVER_CERT -days 365 -extensions v3_req -extfile $SERVER_EXT