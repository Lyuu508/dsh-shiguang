param([Parameter(Mandatory=$true)][string]$Uri)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$target = [Uri]$Uri
if ($target.Scheme -ne 'https' -or $target.UserInfo -or $target.Port -ne 443 -or $target.Host -notin @('api.github.com','raw.githubusercontent.com')) { throw 'Invalid public metadata address' }
$request = [System.Net.HttpWebRequest]::Create($target)
$request.AllowAutoRedirect = $false
$request.Timeout = 20000
$request.ReadWriteTimeout = 20000
$request.UserAgent = 'dsh-shiguang'
$request.Accept = 'application/json'
$response = $request.GetResponse()
try {
  $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  if ($text.Length -gt 2097152) { throw 'Metadata exceeds size budget' }
  $text | ConvertFrom-Json | Out-Null
  [Console]::Write($text)
} finally { $response.Close() }
