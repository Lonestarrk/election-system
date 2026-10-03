# Prövar fixturerna med .NET:s System.Security.Cryptography.Xml.SignedXml, en
# implementation av XMLDSig som är oberoende av läsaren i xmldsig.ts.
# Kör: powershell -NoProfile -ExecutionPolicy Bypass -File check-dotnet.ps1
Add-Type -AssemblyName System.Security
foreach ($f in @('dotnet-exc-c14n.xml', 'dotnet-inc-c14n.xml', 'dotnet-redundant-xmlns.xml')) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  $doc.Load((Join-Path $PSScriptRoot $f))
  $sx = New-Object System.Security.Cryptography.Xml.SignedXml($doc)
  $sx.LoadXml($doc.DocumentElement)
  $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
  $ns.AddNamespace('ds', 'http://www.w3.org/2000/09/xmldsig#')
  $b64 = $doc.SelectSingleNode('//ds:X509Certificate', $ns).InnerText
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, [Convert]::FromBase64String($b64))
  Write-Output "$f : .NET SignedXml.CheckSignature = $($sx.CheckSignature($cert, $true))"
}
