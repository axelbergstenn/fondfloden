# Enkel lokal webbserver för utveckling: powershell -File scripts/serve.ps1, öppna http://localhost:8765
param([int]$Port = 8765, [string]$Root = "site")
$root = (Resolve-Path $Root).Path
$types = @{ ".html" = "text/html; charset=utf-8"; ".json" = "application/json; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".css" = "text/css; charset=utf-8"; ".svg" = "image/svg+xml" }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serverar $root på http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart("/"))
  if (-not $path -or $path.EndsWith("/")) { $path += "index.html" }
  $file = Join-Path $root $path
  if ((Test-Path $file -PathType Leaf) -and (Resolve-Path $file).Path.StartsWith($root)) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $ctx.Response.ContentType = $types[[System.IO.Path]::GetExtension($file)]
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.Close()
}
