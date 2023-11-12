#!/bin/bash

# Define variables
CA_KEY="ca-key.pem"
CA_CERT="ca-cert.pem"
SERVER_KEY="server-key.pem"
SERVER_CSR="server-csr.pem"
SERVER_CERT="server-cert.pem"
SERVER_EXT="server-ext.cnf"
CLIENT_KEY="client-key.pem"
CLIENT_CSR="client-csr.pem"
CLIENT_CERT="client-cert.pem"
CLIENT_EXT="client-ext.cnf"

# Generate CA key and certificate
openssl genrsa -out $CA_KEY 4096
openssl req -new -x509 -key $CA_KEY -sha256 -out $CA_CERT -days 365 -subj "/CN=MyCA"

# Create server config file for SAN
cat > $SERVER_EXT <<- "EOF"
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
[req_distinguished_name]
[ v3_req ]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
DNS.2 = example.com
EOF

# Generate server key and CSR
openssl genrsa -out $SERVER_KEY 4096
openssl req -new -key $SERVER_KEY -out $SERVER_CSR -subj "/CN=localhost" -config $SERVER_EXT

# Sign the server CSR with the CA certificate to get the server certificate
openssl x509 -req -in $SERVER_CSR -CA $CA_CERT -CAkey $CA_KEY -CAcreateserial -out $SERVER_CERT -days 365 -extensions v3_req -extfile $SERVER_EXT

# Create client config file for SAN
cat > $CLIENT_EXT <<- "EOF"
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
[req_distinguished_name]
[ v3_req ]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names
[alt_names]
DNS.1 = client.example.com
EOF

# Generate client key and CSR
openssl genrsa -out $CLIENT_KEY 4096
openssl req -new -key $CLIENT_KEY -out $CLIENT_CSR -subj "/CN=Client" -config $CLIENT_EXT

# Sign the client CSR with the CA certificate to get the client certificate
openssl x509 -req -in $CLIENT_CSR -CA $CA_CERT -CAkey $CA_KEY -CAcreateserial -out $CLIENT_CERT -days 365 -extensions v3_req -extfile $CLIENT_EXT

echo "Certificates with SANs generated successfully."
