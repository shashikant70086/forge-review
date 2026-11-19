param([int]$Port = 8790, [string]$DataSuffix = '')
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
$env:PORT = "$Port"
if ($DataSuffix) { $env:APP_DATA_DIR_SUFFIX = $DataSuffix }
npx.cmd --yes @truefoundry/trueforge@0.183.2
