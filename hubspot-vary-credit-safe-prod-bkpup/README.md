# MTG Cloud Function Boilerplate Typescript

## Get started localy with :

```bash
git clone
cd cloud-function-ts-boilerplate
npm i
npm run dev
```

The project come with a function wrapper for the fetch api with types already setup

```ts
const data = await request<YourType>(`${url}`);
```
Convert your json to types with : https://transform.tools/json-to-typescript
### Add or remove environment variables for the cloud function in .env.yml

A tab is needed before the NAME: value
And an empty line is needed at the end
If you don't need environment variables you can delete the file

```yml
---
  yourVar: value

```

### To install the hubspot SDK run the next command and add your credentials inside the .env.yml

```bash
npm i @hubspot/api-client
```

## Deployment

### Rename the function with the following script

```bash
./rename.sh newFunctionName
```

### Change the project name inside the gcp.config.yml

```yml
gcp:
  ...
  project: project
```

### To deploy the app run

```bash
./deploy.sh
```
