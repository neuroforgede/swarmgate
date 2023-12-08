#!/bin/bash

# Define variables
CA_KEY="ca-key.pem"
CA_CERT="ca-cert.pem"

# Generate CA key and certificate
openssl genrsa -out $CA_KEY 4096
openssl req -new -x509 -key $CA_KEY -sha256 -out $CA_CERT -days 365 -subj "/CN=MyCA"
