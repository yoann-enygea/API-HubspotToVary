#!/bin/bash

read -p "Are you sure you want to deploy the function ? [Yy]" -n 1 -r
echo    # move to a new line
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
  echo "Exited the script"
  [[ "$0" = "$BASH_SOURCE" ]] && exit 1 || return 1 # handle exits from shell or function but don't exit interactive shell
fi

function parse_yaml {
   local prefix=$2
   local s='[[:space:]]*' w='[a-zA-Z0-9_]*' fs=$(echo @|tr @ '\034')
   sed -ne "s|^\($s\):|\1|" \
        -e "s|^\($s\)\($w\)$s:$s[\"']\(.*\)[\"']$s\$|\1$fs\2$fs\3|p" \
        -e "s|^\($s\)\($w\)$s:$s\(.*\)$s\$|\1$fs\2$fs\3|p"  $1 |
   awk -F$fs '{
      indent = length($1)/2;
      vname[indent] = $2;
      for (i in vname) {if (i > indent) {delete vname[i]}}
      if (length($3) > 0) {
         vn=""; for (i=0; i<indent; i++) {vn=(vn)(vname[i])("_")}
         printf("%s%s%s=\"%s\"\n", "'$prefix'",vn, $2, $3);
      }
   }'
}

echo "Starting the deploy script"
echo "Compiling the ts files"
npx tsc
cp package.json dist/package.json
cp package-lock.json dist/package-lock.json
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('dist/package.json', 'utf8'));
p.main = 'src/index.js';
fs.writeFileSync('dist/package.json', JSON.stringify(p, null, 2));
"
eval $(parse_yaml gcp.config.yml "CONF_")

echo "Start of the gcp deployment" 

gcloud functions deploy $CONF_gcp_name \
  --gen2 \
  --region=$CONF_gcp_region \
  --egress-settings=all \
  --vpc-connector connector-vpc \
  --runtime=$CONF_gcp_runtime \
  --source=$CONF_gcp_source \
  --entry-point=$CONF_gcp_name \
  --project=$CONF_gcp_project \
  --trigger-http \
  --env-vars-file .env.yml \
  --allow-unauthenticated

echo "finished"