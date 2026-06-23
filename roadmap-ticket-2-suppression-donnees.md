# Ticket 2 - suppression de donnees HubSpot non repercutee dans Vary

## 1. Corriger le principe de mapping

Probleme actuel :

```ts
sMobile: mobile || undefined
```

ou :

```ts
sGSM: normalizePhone(p.mobilephone || p.phone)
```

Quand HubSpot envoie une valeur vide, le code transforme la valeur en `undefined`. Axios/JSON n'envoie pas le champ, donc Vary garde l'ancienne valeur.

Regle cible :

- champ absent du payload HubSpot : ne rien envoyer a Vary;
- champ present mais vide dans HubSpot : envoyer `""` a Vary pour vider la valeur;
- champ present avec valeur : envoyer la valeur normalisee.

## 2. Ajouter des helpers pour les champs supprimables

Fichiers :

- `hubspot-vary-contact-prod/src/index.ts`
- `hubspot-vary-contact/src/index.ts`
- `hubspot-vary-customers-prod/src/index.ts`
- `hubspot-vary-customers/src/index.ts`

Ajouter pres de `hsVal` :

```ts
const hasHsField = (node: any, key: string): boolean => {
  if (!node) return false;
  if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, key)) return true;
  return Object.prototype.hasOwnProperty.call(node, key);
};

const hsClearableText = (node: any, key: string): string | undefined => {
  if (!hasHsField(node, key)) return undefined;
  const value = hsVal(node, key);
  if (value == null) return "";
  return value.toString().trim();
};

const hsClearablePhone = (node: any, key: string): string | undefined => {
  const value = hsClearableText(node, key);
  if (typeof value === "undefined") return undefined;
  return value ? value.replace(/[^\d+]/g, "") : "";
};
```

## 3. Contacts : ne plus utiliser `|| undefined`

Dans `hubspot-vary-contact-prod/src/index.ts` et `hubspot-vary-contact/src/index.ts`, remplacer les lectures :

```ts
const phone = normalizePhone(hsVal(payload, "phone") || payload.phone);
const mobile = normalizePhone(hsVal(payload, "mobilephone") || hsVal(payload, "mobilphone") || payload.mobilephone || payload.mobilphone);
```

par :

```ts
const phone = hsClearablePhone(payload, "phone");
const mobile =
  hsClearablePhone(payload, "mobilephone") ??
  hsClearablePhone(payload, "mobilphone");
```

Puis remplacer dans `contactData` :

```ts
sPhone: phone || undefined,
sMobile: mobile || undefined,
TELEPHONE: phone || undefined,
GSM: mobile || undefined,
```

par :

```ts
sPhone: phone,
sMobile: mobile,
TELEPHONE: phone,
GSM: mobile,
```

Dans le fichier test, adapter le nom existant :

```ts
sMobilePhone: mobile,
```

Objectif : si `mobilephone` est vide dans HubSpot, envoyer `sMobile: ""` et `GSM: ""` a Vary.

## 4. Clients : ne pas fallback sur `phone` quand `mobilephone` est vide

Dans `hubspot-vary-customers-prod/src/index.ts`, remplacer :

```ts
phone: hsVal(payload, "phone") || hsVal(payload, "sPhone"),
mobilephone: hsVal(payload, "mobilephone") || hsVal(payload, "sGSM"),
```

par :

```ts
phone:
  hsClearableText(payload, "phone") ??
  hsClearableText(payload, "sPhone"),
mobilephone:
  hsClearableText(payload, "mobilephone") ??
  hsClearableText(payload, "sGSM"),
```

Puis remplacer dans `customerData` :

```ts
sPhone: normalizePhone(p.phone),
sGSM: normalizePhone(p.mobilephone || p.phone),
```

par :

```ts
sPhone: typeof p.phone === "undefined" ? undefined : normalizePhone(p.phone) || "",
sGSM: typeof p.mobilephone === "undefined" ? undefined : normalizePhone(p.mobilephone) || "",
```

Faire le meme principe dans `hubspot-vary-customers/src/index.ts`.

Objectif : supprimer le mobile HubSpot doit vider `sGSM` dans Vary, pas reprendre `sPhone`.

## 5. Nettoyer les payloads sans supprimer les chaines vides

Si un nettoyage de payload est ajoute, ne pas filtrer les valeurs avec `if (value)`.

Utiliser une fonction qui supprime seulement `undefined` :

```ts
const removeUndefined = (data: Record<string, any>): Record<string, any> =>
  Object.fromEntries(
    Object.entries(data).filter(([, value]) => typeof value !== "undefined")
  );
```

Ne pas supprimer `""`, car c'est la valeur qui indique a Vary de vider le champ.

## 6. Verifications

Tester en qualif :

- supprimer `mobilephone` dans HubSpot;
- verifier que `sent_payload` contient `sMobile: ""` ou `sGSM: ""`;
- verifier dans Vary que le telephone mobile est vide;
- modifier un champ non inclus dans le payload HubSpot;
- verifier que ce champ non inclus n'est pas efface dans Vary.
