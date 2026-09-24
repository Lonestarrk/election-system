/**
 * TESTNYCKEL, INTE HEMLIG. HÖR BARA TILL BANKID-ATTRAPPEN OCH ANVÄNDS ALDRIG I DRIFT.
 *
 * Larmar en hemlighetsskanner på den privata nyckeln nedan kan larmet avfärdas.
 * Nyckeln är attrappens egen utfärdande mellannivå, incheckad med avsikt så att
 * attrappen är självständig. Den ger ingen åtkomst till något system: den kan
 * bara utfärda certifikat som attrappens egen rot godtar, och den roten litar
 * bara demoläget på.
 *
 * Skapad av scripts/generate-mock-bankid-ca.ts med openssl, 2026-09-24.
 * Redigera inte för hand, kör skriptet igen.
 *
 * VARFÖR DEN ÄR INCHECKAD.
 *
 * Attrappen utfärdar ett certifikat vid varje underskrift, som BankID:s CA
 * gör, och till det behöver den nyckeln. Följden står i
 * src/lib/known-limitations.ts: i demoläget kan den som driver demon utfärda
 * ett giltigt certifikat för vem som helst och förfalska en underskrift.
 * Skyddet gäller med riktig BankID, där nyckeln finns hos BankID och inte hos
 * den som driver systemet.
 *
 * Bara attrappen och testerna får importera filen, och
 * tests/security/module-boundaries.test.ts kräver det.
 */
export const MOCK_BANKID_INTERMEDIATE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDxzCCAq+gAwIBAgIQbQp1CYw13UXo8ZeeQfV8OzANBgkqhkiG9w0BAQsFADBo
MQswCQYDVQQGEwJTRTEdMBsGA1UECgwUVmFsc3lzdGVtZXRzIGF0dHJhcHAxOjA4
BgNVBAMMMUF0dHJhcHBlbnMgQmFua0lELXJvdCwgdGVzdGZpeHR1ciwgYWxkcmln
IGkgZHJpZnQwHhcNMjYwOTI0MTA0MTA3WhcNNDYwOTE5MTA0MTA3WjBvMQswCQYD
VQQGEwJTRTEdMBsGA1UECgwUVmFsc3lzdGVtZXRzIGF0dHJhcHAxQTA/BgNVBAMM
OEF0dHJhcHBlbnMgQmFua0lELXV0ZsOkcmRhcmUsIHRlc3RmaXh0dXIsIGFsZHJp
ZyBpIGRyaWZ0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArpaw5I8H
H3t772Df4OKKYn0UYWKEw8CT9ydv/XXJ8hartRA72fyUbKBWlYPoKlgf3HE+EelS
b2YJM6lU+z2mFlIvlx21dCjKX8KpzBP4STNcCnok3pGCGhkSpyQk6m8n/Hiq0Xim
Lb1Q2zERJ1GvJEXZ9Odk/TSkqCUpGokXkb1obskp7YraBaUjm4SMlMgrhUHPEtll
xJu0Q4bCGbNxgPdRzs5RCWNthB6AYFC1KLFKsaGloPQXCxEQTClnmBYQODb4F/uO
CILOnh120whxrK8p+MUf0TCFXSMwAvpFEUhCK+mLLkKxWfqhWo2OGsSOqy6tG/TW
DZfEX/LXuaw3EwIDAQABo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB
/wQEAwIBBjAdBgNVHQ4EFgQUoPuGBpFRzzRY7WqDZK8tCD8fMqUwHwYDVR0jBBgw
FoAU6eunXtB685DisKwsMT+tBVkUpIMwDQYJKoZIhvcNAQELBQADggEBABEAVu4m
2XMYwEQYGtnKTvJ83GrR3cCbXmCNR3FWDK4/jdAqkGpoW/5SQZBAy21yA94doOJ/
G9hxnEPlJ4hE2OffQl2bHNf4tdYib5z+fLMNJTCuIylZ7fcYEFDi7WO/A4rbxb97
mBhxXIjSLek7pczwhCyHSfphuPvIGGqLCRUuYIbBZSYA7CHLIZd0I2b+4IMZ4IH6
frLeMsMSvyQh2RoXEVFDGfeKjvZznvP8n+TR7vH6z5JSgXiWZLVGgCntdh+8f8VZ
1OTNORuuIfqxDdORix29RfI89ydHyQ0lkOiIhoFs+k3DkC99oJ+elJGKZRfducWa
CmAuLC7vh461fH0=
-----END CERTIFICATE-----
`

export const MOCK_BANKID_INTERMEDIATE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCulrDkjwcfe3vv
YN/g4opifRRhYoTDwJP3J2/9dcnyFqu1EDvZ/JRsoFaVg+gqWB/ccT4R6VJvZgkz
qVT7PaYWUi+XHbV0KMpfwqnME/hJM1wKeiTekYIaGRKnJCTqbyf8eKrReKYtvVDb
MREnUa8kRdn052T9NKSoJSkaiReRvWhuySntitoFpSObhIyUyCuFQc8S2WXEm7RD
hsIZs3GA91HOzlEJY22EHoBgULUosUqxoaWg9BcLERBMKWeYFhA4NvgX+44Igs6e
HXbTCHGsryn4xR/RMIVdIzAC+kURSEIr6YsuQrFZ+qFajY4axI6rLq0b9NYNl8Rf
8te5rDcTAgMBAAECggEAGwxyrH5ySpDdkyktllBSw06AnVPfoNpRsk10Xs7kcjLL
+Hni4/NrZWbz8yckDYdorEUJKko9QNAMpenapjAXbsbd46oxJiV5sRteJiWD5odj
/6WL18WwY+21g5qoc3+0MLvbLyfjixuVDtiLwU049sQxr+03qrkAt6JGO3u44JW3
tmSweYZH6LD4mKUa/9fYJazobyZujnJvtUmrXqCose8XPEbczFSc+0R0h9JLzPpI
HEOt4wWIpHdCkl7ex/hLY1KVWqlQ915BPs7NPxszM1oRJYgNaN1UPdhAASWhJAiG
kvVfDAKnLAcGa/8it9YImNBdiPAxJuG/E4gd5UbyuQKBgQDXs6r4Axu386JDCRzL
g04ZoqKOlgALaokls5twP4YPekFPqQuCQFsdZ3IsUYOoF2y2+z8TP3YJXvU3tanF
v8+CGhuvdAT5oyiiFGQQaLQznP+4Z/pgNKDaVIwOTxAHa8NoDYX/8daDPLrdIP6+
W7cEldeNfIyqLfHNlhuwcrSpuwKBgQDPNLXEIg9jcsTiRVYzyeN12q24rS+JzkRF
4U9PeYkC6GxIB1OQ8hGfC1QGZRWMQpHdfAW1ZYdKMjGhDZF95ShUD8/A+dJbpkHq
jdUu8vjgHcw/3kqrA8B9iEgeM2asFoG5EJx/+APEwdwTXipocw37eFCY4HnUr25Y
YYEXO1kGiQKBgQC2ieiEi/TYHkjR3BNPMqZUUWqpqc0N3DGGA1Hmkwt7a6V7qX4A
0z+ISbO4R59YD8LDsyl0u37DfWWdqJGstJ8B5eBKAa/4JphLWWA49rKQ/yr1PqEG
62K4gVYpAcV50juCgfdFWr6DP1CPs82BAJKIQdoxdRaBKfJ4XbC/CMNU4wKBgEcK
5X9XxjrssMB70XB0Of7AeWumRXRUOmhTNeQj4WwT0HxptqctuAj101tV8Stj76sm
yLZHFznDN+zmQAoQNeGMgkjB3vP5bwRCmOM9/0KoNM15I9S6tpbT0RY5vWwnU1bm
cSIXIQOnDBO/535kZFjiCZBA9sSLWaQH2kDi4kUxAoGAJXC59lMSAQeTN5rlO7tp
qnEV1iGxgZGdKZi9gO5KJdbaO0tYN7vjabXy1Rt60ktpjFw/oXAd85JSaJDiH6dI
uNW9/gMjhd7QUZtCM+ytFHwpUnB+6+ZcEE23neE7iDtzi5wNOortEq4AHKw381UJ
MB0H5lWB2h7GhQ4naqYNOFE=
-----END PRIVATE KEY-----
`
