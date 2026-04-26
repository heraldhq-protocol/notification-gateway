# AWS KMS Configuration for Herald

Herald uses AWS Key Management Service (KMS) to securely wrap critical private keys for the production environment. This prevents raw private keys from being exposed in environment variables or configuration files.

## 1. Keys Required

You need to create one or more KMS Symmetric Encryption keys. It is recommended to use separate KMS keys for different environments (Staging vs. Production) and ideally separate keys for the Authority Secret and Enclave Secret, though a single key per environment is acceptable.

- **Authority Key**: Used to sign ZK compressed delivery receipts on Solana.
- **Enclave Key**: Used to decrypt encrypted notifications for delivery (X25519).

## 2. Creating the KMS Keys

1. Navigate to **AWS Console > Key Management Service (KMS)**.
2. Click **Create a key**.
3. **Key type**: Symmetric.
4. **Key usage**: Encrypt and decrypt.
5. **Advanced options**: Default (KMS).
6. Provide an alias (e.g., `herald/prod/authority-key` and `herald/prod/enclave-key`).
7. Assign key administrators (your IAM user/role).
8. Assign key usage permissions to the **ECS Task Execution Role** that the Herald Gateway will run under.

## 3. Generating the Ciphertexts

Once you have your raw private keys (the Base58 string for the Authority key, and the 64-character hex string for the X25519 Enclave key) and your KMS Key IDs, you must encrypt them using the AWS CLI.

### Encrypting the Authority Secret

The Authority Secret is a Base58 string.

```bash
# Example
aws kms encrypt \
    --key-id alias/herald/prod/authority-key \
    --plaintext fileb://<(echo -n "YOUR_BASE58_SECRET") \
    --query CiphertextBlob \
    --output text
```
*Note: Using `fileb://<(echo -n "...")` ensures no trailing newline is encrypted.*

Store the resulting Base64 string. Then, decode it into HEX format as required by the Herald Gateway configuration:
```bash
echo "YOUR_BASE64_CIPHERTEXT" | base64 --decode | xxd -p | tr -d '\n'
```

### Encrypting the Enclave X25519 Key

The Enclave Secret is a 32-byte raw key. You must encrypt the raw bytes (not the hex string representation).

```bash
# Convert your 64-char hex string to raw bytes and encrypt
echo -n "YOUR_64_CHAR_HEX" | xxd -r -p > raw_enclave.bin

aws kms encrypt \
    --key-id alias/herald/prod/enclave-key \
    --plaintext fileb://raw_enclave.bin \
    --query CiphertextBlob \
    --output text > enclave_base64.txt

# Convert Base64 output to Hex
cat enclave_base64.txt | base64 --decode | xxd -p | tr -d '\n'
```

## 4. Environment Variables Configuration

In your ECS Task Definition, configure the following environment variables. **Do not put the raw `HERALD_AUTHORITY_SECRET` or `HERALD_X25519_PRIV_HEX` in the production environment.**

```env
# Authority Setup
HERALD_AUTHORITY_KMS_KEY_ID="arn:aws:kms:us-east-1:123456789012:key/your-key-id"
HERALD_AUTHORITY_SECRET_CIPHERTEXT="<THE_HEX_STRING_GENERATED_ABOVE>"

# Enclave Setup
AWS_KMS_KEY_ID="arn:aws:kms:us-east-1:123456789012:key/your-enclave-key-id"
HERALD_X25519_PRIV_CIPHERTEXT="<THE_HEX_STRING_GENERATED_ABOVE>"
```

## 5. IAM Role Permissions

The ECS Task Role (not just the execution role) must have `kms:Decrypt` permissions for the specific Key ARNs.

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "kms:Decrypt",
            "Resource": [
                "arn:aws:kms:us-east-1:123456789012:key/authority-key-id",
                "arn:aws:kms:us-east-1:123456789012:key/enclave-key-id"
            ]
        }
    ]
}
```
If using AWS Nitro Enclaves in the future, the KMS Key Policy must also allow the Enclave's PCR values to decrypt the key.
