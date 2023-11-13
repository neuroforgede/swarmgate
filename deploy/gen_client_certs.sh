#!/bin/bash

# Define variables
CA_KEY="ca-key.pem"
CA_CERT="ca-cert.pem"


CLIENTS=(
    someuser
)

for CLIENT in "${CLIENTS[@]}"; do
    echo "Generating certificates for client $CLIENT"
    rm -rf clients/$CLIENT
    mkdir -p clients/$CLIENT

    CLIENT_KEY="clients/$CLIENT/key.pem"
    CLIENT_CERT="clients/$CLIENT/cert.pem"
    CLIENT_CSR="clients/$CLIENT/client-csr.pem"
    CLIENT_EXT="clients/$CLIENT/client-ext.cnf"

    cp $CA_CERT clients/$CLIENT/ca.pem

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
DNS.1 = localhost
EOF


    # Generate client key and CSR
    openssl genrsa -out $CLIENT_KEY 4096
    openssl req -new -key $CLIENT_KEY -out $CLIENT_CSR -subj "/CN=$CLIENT" -config $CLIENT_EXT

    # Sign the client CSR with the CA certificate to get the client certificate
    openssl x509 -req -in $CLIENT_CSR -CA $CA_CERT -CAkey $CA_KEY -CAcreateserial -out $CLIENT_CERT -days 365 -extensions v3_req -extfile $CLIENT_EXT

    echo "Certificates with SANs generated successfully for $CLIENT."
done