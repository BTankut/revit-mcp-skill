# P3-T12 signing fixtures

The focused test generates a fresh RSA keypair under ignored test artifacts,
then signs the same exact `bridge-manifest` through the WP3 signer and the
frozen distribution-integrity canonicalization/oracle functions. No private
key, signed release, or production credential is checked in here.
