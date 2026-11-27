# zeenha fork: Verify every installer and its publisher before release; the old
# inline check validated only the first .exe and accepted any trusted signer.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Directory,
    [string] $ExpectedPublisher,
    [string] $AttestationPath = (Join-Path $Directory 'windows-signature-attestation.json'),
    [switch] $RecordUnsigned,
    [switch] $SkipTimestampCheck # Tests only; the attestation still records the actual timestamp state.
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Annotation([string] $Level, [string] $Message) {
    $escaped = $Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::${Level}::$escaped"
}

try {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw "Windows installer directory '$Directory' does not exist or is not a directory."
    }
    $installers = @(Get-ChildItem -LiteralPath $Directory -File -Force |
        Where-Object { $_.Extension -eq '.exe' })
    if ($installers.Count -eq 0) {
        throw "No Windows installers (.exe) found in '$Directory'."
    }

    $manifestPath = Join-Path $Directory 'latest.yml'
    if (Test-Path -LiteralPath $manifestPath) {
        # electron-builder emits a path and a files list with url fields. Match
        # scalar values (plain or quoted) and allow trailing YAML comments.
        $pattern = @'
(?im)^[ \t]*(?:-[ \t]+)?(?:path|url)[ \t]*:[ \t]*(?:"(?<name>[^"\r\n]*)"|'(?<name>[^'\r\n]*)'|(?<name>[^\r\n]*?))(?:[ \t]+#[^\r\n]*)?[ \t]*\r?$
'@
        $manifest = [string](Get-Content -LiteralPath $manifestPath -Raw)
        foreach ($reference in [regex]::Matches($manifest, $pattern)) {
            $name = $reference.Groups['name'].Value
            if ($name.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and $installers.Name -notcontains $name) {
                throw "latest.yml references '$name', but it is not a top-level installer in '$Directory'."
            }
        }
    }

    if ($RecordUnsigned) {
        Write-Annotation warning 'Windows installers are UNSIGNED and cannot be published.'
    } elseif ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
        throw '-ExpectedPublisher is required to verify Windows installer signatures.'
    }

    $failed = $false
    $entries = @(foreach ($installer in $installers) {
        try {
            $entry = @{
                name = $installer.Name
            }
            if (-not $RecordUnsigned) {
                $sig = Get-AuthenticodeSignature -LiteralPath $installer.FullName
                if ($sig.Status -ne 'Valid') {
                    throw "Authenticode status: $($sig.Status). $($sig.StatusMessage)"
                }
                if ($null -eq $sig.SignerCertificate) {
                    throw 'A signer certificate is required.'
                }

                $cert = $sig.SignerCertificate
                # Trusted Signing certificates rotate; compare the publisher name, not the thumbprint.
                $publisher = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
                if (-not [string]::Equals($publisher, $ExpectedPublisher, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "Expected publisher '$ExpectedPublisher'; found '$publisher' (subject: $($cert.Subject))."
                }

                $timestamped = $null -ne $sig.TimeStamperCertificate
                if (-not $timestamped -and -not $SkipTimestampCheck) {
                    throw 'The Authenticode signature is missing a timestamp.'
                }

                $entry.status = [string]$sig.Status
                $entry.subject = $cert.Subject
                $entry.thumbprint = $cert.Thumbprint
                $entry.timestamped = $timestamped
                Write-Host "Verified signature on '$($installer.Name)'."
                Write-Host "  Subject: $($cert.Subject)"
                Write-Host "  Issuer: $($cert.Issuer)"
                Write-Host "  Thumbprint: $($cert.Thumbprint)"
                Write-Host "  Timestamped: $timestamped"
            }
            $hash = Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
            $entry.sha256 = $hash.Hash.ToLowerInvariant()
            $entry
        } catch {
            $failed = $true
            Write-Annotation error "'$($installer.Name)': $($_.Exception.Message)"
        }
    })
    if ($failed) {
        exit 1
    }

    $attestation = @{
        schemaVersion = 1
        signed = -not $RecordUnsigned
        expectedPublisher = $ExpectedPublisher
        files = $entries
    }
    $json = ConvertTo-Json -InputObject $attestation -Depth 5
    # Resolve relative paths in the PowerShell session, not the .NET process cwd.
    $outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AttestationPath)
    [System.IO.File]::WriteAllText($outputPath, $json, [System.Text.UTF8Encoding]::new($false))
    exit 0
} catch {
    Write-Annotation error $_.Exception.Message
    exit 1
}
