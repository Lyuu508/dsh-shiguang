param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$separator = [System.IO.Path]::DirectorySeparatorChar
$root = [System.IO.Path]::GetFullPath($Destination).TrimEnd($separator) + $separator
[System.IO.Directory]::CreateDirectory($root) | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  if ($zip.Entries.Count -gt 30000) { throw 'Too many archive entries' }
  [long]$total = 0
  $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', $separator).Replace('\', $separator)
    if ($name.Contains(':') -or $name.StartsWith([string]$separator) -or ($name.Split($separator) -contains '..')) { throw 'Unsafe archive entry' }
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $name))
    if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path outside destination' }
    if (!$paths.Add($target)) { throw 'Duplicate archive entry' }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Symbolic link in archive' }
    $total += $entry.Length
    if ($total -gt 805306368) { throw 'Archive exceeds extraction limit' }
    if ($name.EndsWith([string]$separator)) {
      [System.IO.Directory]::CreateDirectory($target) | Out-Null
    } else {
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  }
} finally { $zip.Dispose() }
