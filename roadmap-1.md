# Roadmap - modifications code anti-boucle HubSpot -> Vary

## 1. Lire aussi `sLocalite` comme ville

Fichiers :

- `hubspot-vary-customers-prod/src/index.ts`
- `hubspot-vary-customers/src/index.ts`

Dans la construction de `p.city`, remplacer :

```ts
city: hsVal(payload, "city") || hsVal(payload, "sCity"),
```

par :

```ts
city:
  hsVal(payload, "city") ||
  hsVal(payload, "sCity") ||
  hsVal(payload, "sLocalite"),
```

## 2. Envoyer un payload different en POST et en PATCH

Dans `hubspot-vary-customers-prod/src/index.ts`, remplacer le payload unique `customerData` par :

```ts
const baseCustomerData: Record<string, any> = {
  sDescr: description,
  idExternal: hubspotCompanyId ? String(hubspotCompanyId) : undefined,
  sCodelang: varyLanguage,
  sAddressLine1: p.address,
  sAddressLine2: p.address2,
  sEmail: p.email_client,
  sPhone: normalizePhone(p.phone),
  sGSM: normalizePhone(p.mobilephone || p.phone),
  sSiret: siretDigits,
  sCodeTVA: codeTVAForVary,
  sEmailInvoice: p.email_facture,
  bParticulier: isParticulierCustomer ? 1 : 0,
  nPrivatePerson: isParticulierCustomer ? 1 : 0,
  ...(mailingKeysForVary.length ? { MailingKeys: mailingKeysForVary } : {}),
  sPaymentConditions: paymentConditions,
  credit_safe_delai_paiement: paymentConditions,
  nCreditlimitActive: 1,
  nCreditLimitAmount,
  nInvoiceSendMethod: 2,
};

const customerData: Record<string, any> =
  mode === "update"
    ? {
        ...baseCustomerData,
        sCodepost: p.zip,
        sCodepays: countryISO,
        sLocalite: p.city,
      }
    : {
        ...baseCustomerData,
        sName: name,
        sZipCode: p.zip,
        sCity: p.city,
        sCountryCode: countryISO,
      };
```

Regle :

- `POST` : utiliser `sCity`.
- `PATCH` : utiliser `sLocalite`.
- Ne plus envoyer `sCity` en `PATCH`.

Faire la meme chose en version simplifiee dans `hubspot-vary-customers/src/index.ts`.

## 3. Ne pas PATCH Vary si rien ne change

Ajouter des helpers dans `hubspot-vary-customers-prod/src/index.ts` :

```ts
const normalizeForCompare = (v: any): string =>
  (v ?? "").toString().trim().replace(/\s+/g, " ").toUpperCase();

const currentVaryCity = (customer: any): string | undefined =>
  customer?.sLocalite ?? customer?.sCity ?? customer?.LOCALITE ?? customer?.VILLE;

const hasDifferentVaryValue = (nextValue: any, currentValue: any): boolean =>
  normalizeForCompare(nextValue) !== normalizeForCompare(currentValue);
```

Avant `updateVaryCustomerByCode(...)`, ajouter :

```ts
const shouldPatchVary =
  !currentVaryCustomer ||
  hasDifferentVaryValue(customerData.sLocalite, currentVaryCity(currentVaryCustomer)) ||
  hasDifferentVaryValue(customerData.sCodepost, currentVaryCustomer.sCodepost ?? currentVaryCustomer.sZipCode) ||
  hasDifferentVaryValue(customerData.sCodepays, currentVaryCustomer.sCodepays ?? currentVaryCustomer.sCountryCode);

if (!shouldPatchVary) {
  console.log("Vary update skipped - no effective customer change");
  result = currentVaryCustomer;
} else {
  result = await updateVaryCustomerByCode(customerData, resolvedVaryCode as string, token);
}
```

## 4. Ne pas repatcher HubSpot si les IDs sont deja presents

Dans `hubspot-vary-customers/src/index.ts`, aligner le patch HubSpot avec la prod.

Remplacer l'ajout direct de `idclient_vary` et `code_client_vary` par :

```ts
const currentCodeClientVary =
  hsVal(payload, "code_client_vary") || hsVal(assocCompany, "code_client_vary");
const currentIdVary =
  hsVal(payload, "idclient_vary") ||
  hsVal(assocCompany, "idclient_vary") ||
  hsVal(payload, "id_vary") ||
  hsVal(assocCompany, "id_vary");

const hsProps: Record<string, any> = {};
if (id_vary && String(currentIdVary || "").trim() !== String(id_vary).trim()) {
  hsProps.idclient_vary = String(id_vary);
}
if (varyCodeClient && String(currentCodeClientVary || "").trim() !== String(varyCodeClient).trim()) {
  hsProps.code_client_vary = String(varyCodeClient);
}
```

La prod fait deja cette comparaison : ne pas ajouter de champs metier dans son patch HubSpot.

## 5. Eviter le create automatique apres PATCH 404

Dans `hubspot-vary-customers/src/index.ts`, remplacer le fallback create automatique par un fallback explicite :

```ts
if (
  resolvedVaryCode &&
  e?.response?.status === 404 &&
  process.env.ALLOW_CREATE_ON_UPDATE_404 === "true"
) {
  result = await createVaryCustomer(customerData, token);
} else {
  throw e;
}
```

## 6. Verifier le POST Vary V1

Dans `createVaryCustomer(...)`, verifier avec Vary si les params doivent etre :

```ts
params: {
  sCustomerRef: VARY_CREATE_CUSTOMER_CODE,
  idContact4Log: VARY_CONTACT_ID,
  bCheckDuplicateEmail: 1,
}
```

au lieu de l'actuel `sCustomerCode`.

## 7. Verifications

Executer :

```bash
cd hubspot-vary-customers-prod
npx tsc --noEmit
```

```bash
cd hubspot-vary-customers
npx tsc --noEmit
```

Verifier en qualif :

- creation : payload avec `sCity`, sans `sLocalite`;
- update : payload avec `sLocalite`, sans `sCity`;
- update sans changement : pas de PATCH Vary;
- IDs HubSpot deja identiques : pas de PATCH HubSpot.
