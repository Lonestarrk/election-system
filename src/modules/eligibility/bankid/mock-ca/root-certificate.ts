/**
 * TESTFIXTUR: ATTRAPPENS BANKID-ROT. ALDRIG I DRIFT.
 *
 * Skapad av scripts/generate-mock-bankid-ca.ts med openssl, 2026-09-24.
 * Redigera inte för hand, kör skriptet igen.
 *
 * I demoläget prövas varje BankID-kedja mot den här roten, se
 * ../trusted-roots.ts. Rotens privata nyckel finns inte: skriptet skrev över
 * den och tog bort den så fort mellannivån var utfärdad. Därför kan ingen
 * utfärda en ny mellannivå under roten, och bara attrappens egen mellannivå,
 * ./issuing-ca-test-key.ts, kan utfärda certifikat som roten godtar.
 *
 * Skarpt läge får aldrig lita på den här roten, se UPPGIFT 17 i
 * ../trusted-roots.ts.
 *
 * Fingeravtryck, SHA-256: 37:0E:1A:99:2B:BF:0A:EA:25:32:18:83:77:B5:C9:C1:C7:26:7A:21:FF:D5:69:BD:14:3F:06:54:23:26:79:EA
 */
export const MOCK_BANKID_ROOT_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDnzCCAoegAwIBAgIQTAZQaEdhvHm9IftJYjQU2DANBgkqhkiG9w0BAQsFADBo
MQswCQYDVQQGEwJTRTEdMBsGA1UECgwUVmFsc3lzdGVtZXRzIGF0dHJhcHAxOjA4
BgNVBAMMMUF0dHJhcHBlbnMgQmFua0lELXJvdCwgdGVzdGZpeHR1ciwgYWxkcmln
IGkgZHJpZnQwHhcNMjYwOTI0MTA0MTA3WhcNNDYwOTI0MTA0MTA3WjBoMQswCQYD
VQQGEwJTRTEdMBsGA1UECgwUVmFsc3lzdGVtZXRzIGF0dHJhcHAxOjA4BgNVBAMM
MUF0dHJhcHBlbnMgQmFua0lELXJvdCwgdGVzdGZpeHR1ciwgYWxkcmlnIGkgZHJp
ZnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJF8IEA7G37yobgRxe
Nrai33yceLxWlxgTjjPwR/Odfyqc0Y1/gj09z2z7JfOSvc6mNYh3fjvH++Jq/6Qi
KFp5Gx/1jlRJ6nFrU3Jnbab7jT0pyGfnL09MQLkWIceXWxG+olDkf/aS/omaowy8
KOWVK9ppRtue08g+zPR11KR+vydQ6ncbbTUSboHKolDQUxLvD3KMfZ9WkePDUcZ0
CpM/2Y96LYi96iia0yHf1jKflDcLTLOWvEZs+nG1w61ZJoa/9zsLkRCBRBaA4Kxd
8ggH1BPCqw8tbuw41mnhE8sMZo63bF4EC8p9Iop4w9HAuYjN4hRTen7Afp0Jpxva
/RFxAgMBAAGjRTBDMBIGA1UdEwEB/wQIMAYBAf8CAQEwDgYDVR0PAQH/BAQDAgEG
MB0GA1UdDgQWBBTp66de0HrzkOKwrCwxP60FWRSkgzANBgkqhkiG9w0BAQsFAAOC
AQEAisYUF1Hl8Pc2ZO0ZzRpJP6nCRIzGQ/ozrUyBdoOVr1IRZLjB+0z4KYeZ6r+i
Bfm17tIzJL5lXqdmNGUZsp7mMSV3GPvrYH4ALeGurWcbNkHlcvvSCRImrPOR5YIh
jf4SeEMxaCwmBpmFHRlxJsvvOm3HnGjf4wTkE5R4brO4YdpRx20kZhswIyE/WvCj
e7e6x3xIOJSP5hEGdnbt1xXDmvRyQ547VRe9B34ToLOLtfuBe1uNve8hKB1fG3P5
dgaj4HXhERHPWZj5gYvTZU0Q1yg2p3XjOK9+pl9NJ3OLu0zE8ZDuX4jBmd8mLaIG
jE8PAAhBCrAXahiJEs0VUnKE1A==
-----END CERTIFICATE-----
`
