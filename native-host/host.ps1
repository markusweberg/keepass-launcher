# Native messaging host for KeePass Launcher.
#
# Firefox extensions cannot read files from disk, so this helper reads the
# configured .kdbx file and streams its bytes to the extension. The file stays
# encrypted the whole way; this script never sees the master password.
#
# Protocol (Firefox native messaging): each message is a 4-byte little-endian
# length followed by UTF-8 JSON.
#   -> { type: "stat", path }  <- { type: "stat", path, size, modified }
#   -> { type: "read", path }  <- { type: "meta", size, chunks } then { type: "chunk", index, data(base64) } * chunks
#   on failure                 <- { type: "error", message }

$ErrorActionPreference = 'Stop'

# Firefox rejects messages from the host larger than 1 MB, so the file is sent
# in raw chunks of 512 KB (~683 KB once base64 encoded).
$ChunkBytes = 512KB
$MaxFileBytes = 100MB

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Exact([int]$Count) {
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $stdin.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) { return $null }
        $offset += $read
    }
    return , $buffer
}

function Read-Message {
    $header = Read-Exact 4
    if ($null -eq $header) { return $null }
    $length = [BitConverter]::ToInt32($header, 0)
    if ($length -le 0 -or $length -gt 1MB) { return $null }
    $body = Read-Exact $length
    if ($null -eq $body) { return $null }
    return [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
}

function Send-Message($Message) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Message | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Resolve-DatabasePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'No database path configured.' }
    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
    if (-not [IO.Path]::IsPathRooted($expanded)) { throw 'The database path must be a full path, e.g. C:\Users\you\Documents\Passwords.kdbx' }
    if ([IO.Path]::GetExtension($expanded) -ne '.kdbx') { throw 'The database path must point to a .kdbx file.' }
    if (-not [IO.File]::Exists($expanded)) { throw "File not found: $expanded" }
    return $expanded
}

function Read-DatabaseBytes([string]$Path) {
    # Share ReadWrite so reading works while KeePass has the database open.
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        if ($stream.Length -gt $MaxFileBytes) { throw 'The database file is larger than 100 MB.' }
        $bytes = New-Object byte[] $stream.Length
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { throw 'Unexpected end of file while reading the database.' }
            $offset += $read
        }
        return , $bytes
    }
    finally {
        $stream.Dispose()
    }
}

while ($true) {
    $request = Read-Message
    if ($null -eq $request) { break }

    try {
        $path = Resolve-DatabasePath $request.path
        switch ($request.type) {
            'stat' {
                $info = New-Object IO.FileInfo $path
                Send-Message @{ type = 'stat'; path = $path; size = $info.Length; modified = $info.LastWriteTimeUtc.ToString('o') }
            }
            'read' {
                $bytes = Read-DatabaseBytes $path
                $chunkCount = [int][Math]::Ceiling($bytes.Length / $ChunkBytes)
                Send-Message @{ type = 'meta'; size = $bytes.Length; chunks = $chunkCount }
                for ($i = 0; $i -lt $chunkCount; $i++) {
                    $offset = $i * $ChunkBytes
                    $length = [Math]::Min($ChunkBytes, $bytes.Length - $offset)
                    Send-Message @{ type = 'chunk'; index = $i; data = [Convert]::ToBase64String($bytes, $offset, $length) }
                }
            }
            default { throw "Unknown request type: $($request.type)" }
        }
    }
    catch {
        Send-Message @{ type = 'error'; message = $_.Exception.Message }
    }
}
