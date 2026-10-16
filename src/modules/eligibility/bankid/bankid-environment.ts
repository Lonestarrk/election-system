import { X509Certificate } from 'node:crypto'

/**
 * BANKID:S TVÅ MILJÖER, MED ADRESS OCH FÖRANKRAD SERVERROT (uppgift 17c).
 *
 * Källa: developers.bankid.com/getting-started/environments, hämtad 2026-10-03.
 * Rötterna nedan är kopierade därifrån, och deras SHA-256-fingeravtryck är låsta
 * för sig, så att en ändrad PEM inte går obemärkt förbi: rotens fingeravtryck
 * prövas mot det låsta värdet varje gång roten läses, och det är ett krav för
 * skarpt läge (`bankid-server-root` i src/lib/runtime-mode.ts).
 *
 * VARFÖR ROTEN ÄR FÖRANKRAD I KODEN. BankID:s server visar ett certifikat som är
 * utfärdat av "BankID SSL Root CA v1" i produktion och "Test BankID SSL Root CA v1
 * Test" i testmiljön. Klienten litar bara på den rot som hör till BANKID_ENV, och
 * aldrig på systemets CA-lager: en server med ett certifikat från en vanlig
 * webb-CA, eller från BankID:s andra miljö, godtas inte. Produktion vägrar alltså
 * testroten och testmiljön produktionsroten.
 *
 * DET HÄR ÄR INTE ROTEN FÖR VÄLJARNAS CERTIFIKAT. Kedjan i en underskrift går till
 * BankID:s rot för kundcertifikat, som läggs i BANKID_ROOT_CERTIFICATES, se
 * ./trusted-roots.ts. Den rotens fingeravtryck är låst längre ned, i
 * `CUSTOMER_ROOTS` (uppgift 17d).
 */

export type BankIdEnvironment = 'test' | 'production'

/** De låsta fingeravtrycken, SHA-256 som OpenSSL skriver dem. */
export const SERVER_ROOT_SHA256: Record<BankIdEnvironment, string> = {
  test: 'F3:D0:74:0E:BF:B3:70:0E:3B:81:AA:79:1F:EE:45:14:72:69:8C:84:E1:99:C2:EB:48:A4:43:FF:1D:5B:40:5C',
  production: 'E6:A2:D4:5C:0A:10:51:C9:59:42:86:49:F8:6A:09:A9:B2:15:2C:D5:51:99:3C:C2:EB:4C:F0:94:BD:AC:BE:CB',
}

/** CN = Test BankID SSL Root CA v1 Test, OU = Infrastructure CA, O = Finansiell ID-Teknik BID AB. */
const TEST_SERVER_ROOT = `-----BEGIN CERTIFICATE-----
MIIF0DCCA7igAwIBAgIIIhYaxu4khgAwDQYJKoZIhvcNAQENBQAwbDEkMCIGA1UE
CgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQLDBFJbmZyYXN0
cnVjdHVyZSBDQTEoMCYGA1UEAwwfVGVzdCBCYW5rSUQgU1NMIFJvb3QgQ0EgdjEg
VGVzdDAeFw0xNDExMjExMjM5MzFaFw0zNDEyMzExMjM5MzFaMGwxJDAiBgNVBAoM
G0ZpbmFuc2llbGwgSUQtVGVrbmlrIEJJRCBBQjEaMBgGA1UECwwRSW5mcmFzdHJ1
Y3R1cmUgQ0ExKDAmBgNVBAMMH1Rlc3QgQmFua0lEIFNTTCBSb290IENBIHYxIFRl
c3QwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCAKWsJc/kV/0434d+S
qn19mIr85RZ/PgRFaUplSrnhuzAmaXihPLCEsd3Mh/YErygcxhQ/MAzi5OZ/anfu
WSCwceRlQINtvlRPdMoeZtu29FsntK1Z5r2SYNdFwbRFb8WN9FsU0KvC5zVnuDMg
s5dUZwTmdzX5ZdLP7pdgB3zhTnra5ORtkiWiUxJVev9keRgAo00ZHIRJ+xTfiSPd
Jc314maigVRQZdGKSyQcQMTWi1YLwd2zwOacNxleYf8xqKgkZsmkrc4Dp2mR5Pkr
nnKB6A7sAOSNatua7M86EgcGi9AaEyaRMkYJImbBfzaNlaBPyMSvwmBZzp2xKc9O
D3U06ogV6CJjJL7hSuVc5x/2H04d+2I+DKwep6YBoVL9L81gRYRycqg+w+cTZ1TF
/s6NC5YRKSeOCrLw3ombhjyyuPl8T/h9cpXt6m3y2xIVLYVzeDhaql3hdi6IpRh6
rwkMhJ/XmOpbDinXb1fWdFOyQwqsXQWOEwKBYIkM6cPnuid7qwaxfP22hDgAolGM
LY7TPKUPRwV+a5Y3VPl7h0YSK7lDyckTJdtBqI6d4PWQLnHakUgRQy69nZhGRtUt
PMSJ7I4Qtt3B6AwDq+SJTggwtJQHeid0jPki6pouenhPQ6dZT532x16XD+WIcD2f
//XzzOueS29KB7lt/wH5K6EuxwIDAQABo3YwdDAdBgNVHQ4EFgQUDY6XJ/FIRFX3
dB4Wep3RVM84RXowDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBQNjpcn8UhE
Vfd0HhZ6ndFUzzhFejARBgNVHSAECjAIMAYGBCoDBAUwDgYDVR0PAQH/BAQDAgEG
MA0GCSqGSIb3DQEBDQUAA4ICAQA5s59/Olio4svHXiKu7sPQRvrf4GfGB7hUjBGk
YW2YOHTYnHavSqlBASHc8gGGwuc7v7+H+vmOfSLZfGDqxnBqeJx1H5E0YqEXtNqW
G1JusIFa9xWypcONjg9v7IMnxxQzLYws4YwgPychpMzWY6B5hZsjUyKgB+1igxnf
uaBueLPw3ZaJhcCL8gz6SdCKmQpX4VaAadS0vdMrBOmd826H+aDGZek1vMjuH11F
fJoXY2jyDnlol7Z4BfHc011toWNMxojI7w+U4KKCbSxpWFVYITZ8WlYHcj+b2A1+
dFQZFzQN+Y1Wx3VIUqSks6P7F5aF/l4RBngy08zkP7iLA/C7rm61xWxTmpj3p6SG
fUBsrsBvBgfJQHD/Mx8U3iQCa0Vj1XPogE/PXQQq2vyWiAP662hD6og1/om3l1PJ
TBUyYXxqJO75ux8IWblUwAjsmTlF/Pcj8QbcMPXLMTgNQAgarV6guchjivYqb6Zr
hq+Nh3JrF0HYQuMgExQ6VX8T56saOEtmlp6LSQi4HvKatCNfWUJGoYeT5SrcJ6sn
By7XLMhQUCOXcBwKbNvX6aP79VA3yeJHZO7XParX7V9BB+jtf4tz/usmAT/+qXtH
CCv9Xf4lv8jgdOnFfXbXuT8I4gz8uq8ElBlpbJntO6p/NY5a08E6C7FWVR+WJ5vZ
OP2HsA==
-----END CERTIFICATE-----
`

/** CN = BankID SSL Root CA v1, OU = Infrastructure CA, O = Finansiell ID-Teknik BID AB. */
const PRODUCTION_SERVER_ROOT = `-----BEGIN CERTIFICATE-----
MIIFvjCCA6agAwIBAgIITyTh/u1bExowDQYJKoZIhvcNAQENBQAwYjEkMCIGA1UE
CgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQLDBFJbmZyYXN0
cnVjdHVyZSBDQTEeMBwGA1UEAwwVQmFua0lEIFNTTCBSb290IENBIHYxMB4XDTEx
MTIwNzEyMzQwN1oXDTM0MTIzMTEyMzQwN1owYjEkMCIGA1UECgwbRmluYW5zaWVs
bCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQLDBFJbmZyYXN0cnVjdHVyZSBDQTEe
MBwGA1UEAwwVQmFua0lEIFNTTCBSb290IENBIHYxMIICIjANBgkqhkiG9w0BAQEF
AAOCAg8AMIICCgKCAgEAwVA4snZiSFI3r64LvYu4mOsI42A9aLKEQGq4IZo257iq
vPH82SMvgBJgE52kCx7gQMmZ7iSm39CEA19hlILh8JEJNTyJNxMxVDN6cfJP1jMH
JeTES1TmVbWUqGyLpyT8LCJhC9Vq4W3t/O1svGJNOUQIQL4eAHSvWTVoalxzomJh
On97ENjXAt4BLb6sHfVBvmB5ReK0UfwpNACFM1RN8btEaDdWC4PfA72yzV3wK/cY
5h2k1RM1s19PjoxnpJqrmn4qZmP4tN/nk2d7c4FErJAP0pnNsll1+JfkdMfiPD35
+qcclpspzP2LpauQVyPbO21Nh+EPtr7+Iic2tkgz0g1kK0IL/foFrJ0Ievyr3Drm
2uRnA0esZ45GOmZhE22mycEX9l7w9jrdsKtqs7N/T46hil4xBiGblXkqKNG6TvAR
k6XqOp3RtUvGGaKZnGllsgTvP38/nrSMlszNojrlbDnm16GGoRTQnwr8l+Yvbz/e
v/e6wVFDjb52ZB0Z/KTfjXOl5cAJ7OCbODMWf8Na56OTlIkrk5NyU/uGzJFUQSvG
dLHUipJ/sTZCbqNSZUwboI0oQNO/Ygez2J6zgWXGpDWiN4LGLDmBhB3T8CMQu9J/
BcFvgjnUyhyim35kDpjVPC8nrSir5OkaYgGdYWdDuv1456lFNPNNQcdZdt5fcmMC
AwEAAaN4MHYwHQYDVR0OBBYEFPgqsux5RtcrIhAVeuLBSgBuRDFVMA8GA1UdEwEB
/wQFMAMBAf8wHwYDVR0jBBgwFoAU+Cqy7HlG1ysiEBV64sFKAG5EMVUwEwYDVR0g
BAwwCjAIBgYqhXBOAQQwDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBDQUAA4IC
AQAJOjUOS2GJPNrrrqf539aN1/EbUj5ZVRjG4wzVtX5yVqPGcRZjUQlNTcfOpwPo
czKBnNX2OMF+Qm94bb+xXc/08AERqJJ3FPKu8oDNeK+Rv1X4nh95J4RHZcvl4AGh
ECmGMyhyCea0qZBFBsBqQR7oC9afYOxsSovaPqX31QMLULWUYoBKWWHLVVIoHjAm
GtAzMkLwe0/lrVyApr9iyXWhVr+qYGmFGw1+rwmvDmmSLWNWawYgH4NYxTf8z5hB
iDOdAgilvyiAF8Yl0kCKUB2fAPhRNYlEcN+UP/KL24h/pB+hZ9mvR0tM6nW3HVZa
DrvRz4VihZ8vRi3fYnOAkNE6kZdrrdO7LdBc9yYkfQdTcy0N+Aw7q4TkQ8npomrV
mTKaPhtGhA7VICyRNBVcvyoxr+CY7aRQyHn/C7n/jRsQYxs7uc+msq6jRS4HPK8o
lnF9usWZX6KY+8mweJiTE4uN4ZUUBUtt8WcXXDiK/bxEG2amjPcZ/b4LXwGCJb+a
NWP4+iY6kBKrMANs01pLvtVjUS9RtRrY3cNEOhmKhO0qJSDXhsTcVtpbDr37UTSq
QVw83dReiARPwGdURmmkaheH6z4k6qEUSXuFch0w53UAc+1aBXR1bgyFqMdy7Yxi
b2AYu7wnrHioDWqP6DTkUSUeMB/zqWPM/qx6QNNOcaOcjA==
-----END CERTIFICATE-----
`

export const BANKID_ENVIRONMENTS: Record<BankIdEnvironment, { baseUrl: string; serverRootPem: string }> = {
  test: { baseUrl: 'https://appapi2.test.bankid.com/rp/v6.0/', serverRootPem: TEST_SERVER_ROOT },
  production: { baseUrl: 'https://appapi2.bankid.com/rp/v6.0/', serverRootPem: PRODUCTION_SERVER_ROOT },
}

/**
 * BankID:s publika RP-certifikat för testmiljön, "FP Testcert 5", som alla kan
 * hämta med frasen qwerty123. Det får aldrig användas i produktion, se
 * `rpCredentialProblem` i ./rp-certificate.ts. Fingeravtrycket är certifikatets
 * i FPTestcert5_20240610.p12 ur FPTestcert5_20240703.zip, hämtad 2026-10-03.
 */
export const PUBLIC_TEST_RP_CERTIFICATE_SHA256 =
  'EF:15:B3:E1:83:7B:D4:AD:E7:E4:BF:A1:D0:A0:7E:9B:E9:36:E0:38:9C:10:80:60:77:D0:EB:51:27:1A:D5:F5'

/**
 * Vad som är fel med serverroten för miljön, eller null. `pem` är bara till för
 * testerna, som prövar att en miljö vägrar den andra miljöns rot.
 */
export function serverRootProblem(
  environment: BankIdEnvironment,
  pem: string = BANKID_ENVIRONMENTS[environment].serverRootPem,
): string | null {
  let root: X509Certificate
  try {
    root = new X509Certificate(pem)
  } catch {
    return `Serverroten för BankID:s ${environment === 'test' ? 'testmiljö' : 'produktion'} går inte att läsa.`
  }
  if (root.fingerprint256 !== SERVER_ROOT_SHA256[environment]) {
    return (
      `Serverroten för BANKID_ENV=${environment} har fingeravtrycket ${root.fingerprint256}, och det ` +
      `låsta är ${SERVER_ROOT_SHA256[environment]}. Klienten litar bara på miljöns egen rot.`
    )
  }
  if (!root.ca) return 'Serverroten är ingen CA.'
  return null
}

/** Serverroten för miljön. Kastar om den inte är den låsta. */
export function serverRootFor(
  environment: BankIdEnvironment,
  pem: string = BANKID_ENVIRONMENTS[environment].serverRootPem,
): X509Certificate {
  const problem = serverRootProblem(environment, pem)
  if (problem) throw new Error(problem)
  return new X509Certificate(pem)
}

/**
 * BANKID:S RÖTTER FÖR KUNDCERTIFIKAT, LÅSTA PER MILJÖ (uppgift 17d, punkt 4, B5).
 *
 * Kedjan i väljarens underskrift går till BankID:s rot för kundcertifikat, inte
 * till TLS-roten ovan. Helgrensgranskningen visade att uppstartsvakten bara
 * prövade att rötterna i BANKID_ROOT_CERTIFICATES inte var attrappens, och skarpt
 * läge mot testmiljön startade med TLS-roten som rot för underskrifterna. Nu ska
 * varje rot i filen vara exakt kundroten för den miljö BANKID_ENV pekar ut, på
 * fingeravtrycket och på subject, se `customerRootProblem` i ./trusted-roots.ts och
 * kravet `bankid-customer-root` i src/lib/runtime-mode.ts. Testmiljöns kundrot kan
 * alltså aldrig hamna i en produktionskonfiguration, och tvärtom.
 *
 * KÄLLA: developers.bankid.com/how-to-guides/verifying-signatures, avsnittet
 * "Instruction and certificates", hämtad 2026-10-16. Sidan länkar till
 * https://cdn.bankid.com/pki/bankid/BankID-Root-CA-v1.pem ("Production certificate")
 * och https://cdn.bankid.com/pki/bankid/Test-BankID-Root-CA-v1-Test.pem ("Test
 * certificate"). Förut (2026-10-03) sa sidan att rötterna lämnades ut på begäran.
 *
 * BankID publicerar certifikaten men inga fingeravtryck. Fingeravtrycken nedan är
 * räknade på filerna som hämtades från adresserna ovan 2026-10-16, och PEM:erna är
 * incheckade här, så att vem som helst kan räkna om dem och jämföra med BankID:s
 * filer. De förankrar alltså just de filerna: byter BankID rot måste den nya
 * granskas och värdena bytas för hand.
 */

/** CN = Test BankID Root CA v1 Test, OU = BankID Member Banks CA, O = Finansiell ID-Teknik BID AB. */
const TEST_CUSTOMER_ROOT = `-----BEGIN CERTIFICATE-----
MIIF0jCCA7qgAwIBAgIISpGbuE9LL/0wDQYJKoZIhvcNAQENBQAwbTEkMCIGA1UE
CgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMR8wHQYDVQQLDBZCYW5rSUQg
TWVtYmVyIEJhbmtzIENBMSQwIgYDVQQDDBtUZXN0IEJhbmtJRCBSb290IENBIHYx
IFRlc3QwHhcNMTEwOTIyMTQwMTMzWhcNMzQxMjMxMTQwMTMzWjBtMSQwIgYDVQQK
DBtGaW5hbnNpZWxsIElELVRla25payBCSUQgQUIxHzAdBgNVBAsMFkJhbmtJRCBN
ZW1iZXIgQmFua3MgQ0ExJDAiBgNVBAMMG1Rlc3QgQmFua0lEIFJvb3QgQ0EgdjEg
VGVzdDCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANPXoOB9BQOW8i2C
Kk7U/d8rFNB0ktVlcgBSh8CKvnTsW3i+NrAM5LY9jgAO9vkHT3bl3nK626zePhmh
dhVXMKAanbcF/NJ/oSF+DKCGx/VgPmCCqVyTMLjID/59diiLg3xNH3NaaBM69qnw
5yOCYkB2wXxcATLO0eTxvL0vdKGJ2HU2AcEtaMMxrScuNCztPuwjYNP0KrYI+y/J
Gkf2dBhomAhDLdQSSW3zXqYgbQvJ8La2ECgo3rGQQRZG9/5MZ5dOWtpAx0ybeCbh
CPO8XIBCHrPZxv60gZK1CTwlZUoMTBSivv+vmFrH8JdmUnOP9e/wNhuM9/fQ0h5t
4BGXoz8M5nxdH6uNJG5SpdxaXYflezBb7YdjgNiF9Yqo3DYTRrZT7dyRLYqlmKQh
T1pqEov1tkXktQF8r1QJkTJO3x1QEzMNCnHyN8iDOqENSE4nhkzU9ESbXNOhFpnc
XJqoFwvbeAJpV7fVwn+Jumyc/zsD9t+1Vo1lM95q1geVPfnA5z7NZ+uaayJx4DhL
MvufDI17fqgiWHe+BMA/vGd8OjFK3JUmCV+7QeG/Z3JWbzU0GeDljqO+H4CQ0+LO
4E4JGEZtxfUu4/XuOkCqiZ4/shoPOOxaXcZlBEMHsDzei0tNSKIxB+PoDTje/BQC
lunVZvjcG2ehpeF540EXgzzECaNLAgMBAAGjdjB0MB0GA1UdDgQWBBRK96NqCNoI
OBcZUyjI2qbWNNhaujAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFEr3o2oI
2gg4FxlTKMjaptY02Fq6MBEGA1UdIAQKMAgwBgYEKgMEBTAOBgNVHQ8BAf8EBAMC
AQYwDQYJKoZIhvcNAQENBQADggIBAJVcP9Sm2tukKW0Qx8EZG9gdXfCmNMrHXF3g
via5zpuSMl9wdXHd1FPdGFshRZJ2sW4mb9vRI81vBIXMFVtLZFzeGHoKyz1g8hfj
uuLKpItw0OwVNdvSRq/TKKxjVKpvt50Eydgnz4Q59YkFlGVyi7+z74mGfvN06Ssj
2WIRtr3UD+IC6Tie6Lm/zuZs4gu0ZP/fddKh7gC3syHLNXQmN+9Y0wkdO7H98K/9
uuIrxWtSOFVatxesw7XJRnq+uYI0IdP8xP8U4S680rTse7nsTguQxzRs2vOyoaXm
Fdf7XQ03btd15Z4yJlEfs9/4ohgafMs49PMkACqyX45/4WBygO0QwMGVIUnKNFBt
/I+0T2SkWFa2JdcRCSTObb7tesoeTIPgI9UcrMvNOG3gxGpB/H5/s7jTV0AOoDgM
hOxieGgyTsZ3oP0k6bc47FJ4nE+vifAluyeXioB5JaN2kvm8eqfzC05zSF40V9GA
zElVDbsBPR/2CE6CMyR+eqip4gDSZ6mnZYPeBecEXU4Xu+RAgqYxjKosfxOpMZsN
+2BSm5QSRLhHacPQTnoQxujnGuUzh5TdAbWqmS0cKEZJ+CACmVLyOphdRoeEQCqQ
8DYAyOtq2S4+hAJW+2Xq4NCdvmjm99r2RFkibSlLtqctj1JyzUC6huUiQXx9KZ8n
FA0TsFHG
-----END CERTIFICATE-----
`

/** CN = BankID Root CA v1, OU = BankID Member Banks CA, O = Finansiell ID-Teknik BID AB. */
const PRODUCTION_CUSTOMER_ROOT = `-----BEGIN CERTIFICATE-----
MIIFwDCCA6igAwIBAgIIMR5YYFp1W4EwDQYJKoZIhvcNAQENBQAwYzEkMCIGA1UE
CgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMR8wHQYDVQQLDBZCYW5rSUQg
TWVtYmVyIEJhbmtzIENBMRowGAYDVQQDDBFCYW5rSUQgUm9vdCBDQSB2MTAeFw0x
MTEyMDcxMjQzNDVaFw0zNDEyMzExMjQzNDVaMGMxJDAiBgNVBAoMG0ZpbmFuc2ll
bGwgSUQtVGVrbmlrIEJJRCBBQjEfMB0GA1UECwwWQmFua0lEIE1lbWJlciBCYW5r
cyBDQTEaMBgGA1UEAwwRQmFua0lEIFJvb3QgQ0EgdjEwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQDFlk0dAUwC63Dz6H/PN6BXL3XW7gFgMwmA9ZAJugBk
2B9OqDExybiZ86U7Q2Ha+5Q0JaHyLDRNz5hRB8hA/mgFYAcCSmHJTy2q5bTbFf2P
Y2SzW9VrY3x0ZR3s8D9+d8KLAWG2TpvYXfmqb+4LRd4SMskFhtBmL55uAoc5lKze
0wFi7O1o+cQP1TOG3Udjqu5jdZkGqZc7XTJzrQPSgyf4Y21tG1ohkHLgAVRDX0xT
nu8G+7Z1NJN7MX2AxyvOVl5kkepPtig+Z0UTyh0dXjdb7Fe/72BxeBqzEcib5Tvj
zqJFIBVqCFQG5iAVaDEblpgP4G6W7w0do7rCQNsAjxmpOuM7/pSi0q57pm2oIgsr
DPBKfugpuFVqUxtFlOw/2NUCoiydLRVJRitTqA49CDmXk56+cLg8Qn1fs9AoQTMg
w5ZYBo6Il79XvbgqV4Ov9tjM0DfQ1bWmB8GpKKUawaRDiikDvpSF6JMeFFQ1dF1b
w7hZYGgmZNaw1UWgYZjwogUgvJkWwYNPoqfgCHGk02bR46+ZErdipUdDsziMw2Ih
4pU3ERl2qxLN1X6I0AwsNotM96/fNENjwls6QhqG8Hgjf+/bR0bceg7mHJ2EwAxH
vPzi3RPD4xASfB3OMfRGwgnE1p+fc/pIwzLYUIVQtAQ7EIm+ArJ9BhQIroG6aHkv
hwIDAQABo3gwdjAdBgNVHQ4EFgQUZ4q6supIHHr1O2g3J3IG65Fjy1MwDwYDVR0T
AQH/BAUwAwEB/zAfBgNVHSMEGDAWgBRnirqy6kgcevU7aDcncgbrkWPLUzATBgNV
HSAEDDAKMAgGBiqFcE4BATAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQENBQAD
ggIBAFMeVmlLBIVAWAlmvqme34hG+k6c1HkPmgAGIZdtcJ1+XZ4MNUg9KKywTkNV
Aqcgy5gcIk3LM9HfHQ2JmUP54XSvXdr1B92m40Up4POH35mlmPZyqQVll0Ad5xrI
R86+HEk9BFmd+ukZ1AvSSSRZ/X7mcbBjcx34QaCVW2CeBdYSCzksjx0LOcEDgKNH
ToOQxrn8x//Ccc7Wf56Boq61JvjQAb1Q1E1BYKmXyJ8818SR1crvMU6xd68Akp0b
mJz7WDSvpjp10BrDyw1uTrn1qVlkOjllwPqHyUckTCAMmv0DkhmjcMSyzRWhAV9f
CTe17f7J+RYXBil9Z8/S4kCsatDGqLT5xgsCvsdca6haZUFh14npW3c8cmk3x6tg
0Nm1L0WxwyM2SOXJj/9vqaWMAq0qtv1izy/3rR0XuxSsw0fGv9LAG9KXcKPAobI/
itu2/3IbYFp2YOJ8GmQRZb8KsuIFxR7A4eB2ZcnlDgCCLIcyQhKt7e0JPkEp1cwM
prlCjCPu1KQrx/8zV5Z19muSw47ZHZ2hAciXKRe5dLsJyST8BqFfU4w8bV4pHfHE
thQ5CRGjBC6OFA7Fcd6rD8eByzaDyM5bDbkfgxBED5JQJrda1/mN1TxxtMrY6YeB
XDJdzaHTe7WXQRdXr5Jv+l1SIGJttNicNaam65wiiH7waAPH
-----END CERTIFICATE-----
`

export const CUSTOMER_ROOTS: Record<BankIdEnvironment, { subject: string; sha256: string; pem: string }> = {
  test: {
    subject: 'O=Finansiell ID-Teknik BID AB\nOU=BankID Member Banks CA\nCN=Test BankID Root CA v1 Test',
    sha256: 'C6:FA:EA:F8:CC:AD:CF:D0:73:8D:C9:91:40:CA:78:8C:1A:19:A9:3F:84:3C:5A:9E:C1:36:98:72:D5:0E:45:F2',
    pem: TEST_CUSTOMER_ROOT,
  },
  production: {
    subject: 'O=Finansiell ID-Teknik BID AB\nOU=BankID Member Banks CA\nCN=BankID Root CA v1',
    sha256: 'CA:32:58:8E:38:5B:96:1D:58:E2:60:10:C6:F8:C8:39:F7:CA:07:1E:49:7D:E6:B7:84:16:40:A6:15:06:FD:31',
    pem: PRODUCTION_CUSTOMER_ROOT,
  },
}

/**
 * Är certifikatet exakt kundroten för miljön? Fingeravtrycket avgör, och subject och
 * utfärdare prövas också, så att ett fel i ett av de låsta värdena inte ensamt
 * släpper igenom en annan rot.
 */
export function isCustomerRoot(environment: BankIdEnvironment, certificate: X509Certificate): boolean {
  const pinned = CUSTOMER_ROOTS[environment]
  return (
    certificate.fingerprint256 === pinned.sha256 &&
    certificate.subject === pinned.subject &&
    certificate.issuer === pinned.subject
  )
}

/**
 * Kundroten för miljön, ur den incheckade PEM:en. Kastar om den inte är den låsta.
 * `pem` är bara till för testerna, som prövar att en miljö vägrar den andras rot.
 */
export function customerRootFor(
  environment: BankIdEnvironment,
  pem: string = CUSTOMER_ROOTS[environment].pem,
): X509Certificate {
  const root = new X509Certificate(pem)
  if (!isCustomerRoot(environment, root)) {
    throw new Error(
      `Kundroten för BANKID_ENV=${environment} har fingeravtrycket ${root.fingerprint256}, och det låsta är ` +
        `${CUSTOMER_ROOTS[environment].sha256}.`,
    )
  }
  return root
}
