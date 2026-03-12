#!/bin/bash
echo "Starting the rename script ..."
slug=$(echo "$1" | iconv -t ascii//TRANSLIT | sed -r s/[^a-zA-Z0-9]+/-/g | sed -r s/^-+\|-+$//g | tr '[:upper:]' '[:lower:]')
echo "Replacing the hubspotVaryContactUpsert in .js, .ts, .json, .sh to ${1}"
find ./ -type f \( -name "index.ts" -or -name "package.json" -or -name "deploy.sh" -or -name "rename.sh" -or -name "gcp.config.yml" \) -exec sed -i '' -e "s/hubspotVaryContactUpsert/${1}/" {} \;
echo "Replacing the hubspotVaryContactUpsert in .json, .sh to ${slug}"
find ./ -type f \( -name "package.json" -or -name "package-lock.json" \) -exec sed -i '' -e "s/\"name\": \"hubspotVaryContactUpsert\"/\"name\": \"${slug}\"/g" {} \;
find ./ -type f \( -name "rename.sh" \) -exec sed -i '' -e "s/hubspotVaryContactUpsert/${slug}/" {} \;
echo "Rename script done"