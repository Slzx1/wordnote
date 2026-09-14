param(
    [ValidateSet('voices', 'synthesize')][string]$Mode = 'voices',
    [string]$OutputFile
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voices = @($synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name.StartsWith('en') })
    if ($Mode -eq 'voices') {
        $result = @($voices | ForEach-Object { @{ name = $_.VoiceInfo.Name; lang = $_.VoiceInfo.Culture.Name } })
        ConvertTo-Json -InputObject $result -Compress
    } else {
        $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
        if (-not ($voices | Where-Object { $_.VoiceInfo.Name -eq $request.voice })) { throw 'English voice is unavailable.' }
        $synthesizer.SelectVoice([string]$request.voice)
        $synthesizer.Rate = [Math]::Max(-10, [Math]::Min(10, [int][Math]::Round(10 * [Math]::Log([double]$request.rate, 2))))
        $synthesizer.SetOutputToWaveFile($OutputFile)
        $synthesizer.Speak([string]$request.text)
        $synthesizer.SetOutputToNull()
    }
} finally {
    $synthesizer.Dispose()
}
