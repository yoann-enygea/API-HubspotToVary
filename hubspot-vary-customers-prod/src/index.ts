import * as functions from "@google-cloud/functions-framework";
import axios from "axios";
import { Request, Response } from "@google-cloud/functions-framework";

/**
 * =============================
 * Environnement (TEST/PROD)
 * =============================
 */
const VARY_API_URL =
  process.env.VARY_API_URL || "https://varyws06.enygea.com/prod/1/auth/token";

// URL V1
const VARY_CUSTOMER_URL =
  process.env.VARY_CUSTOMER_URL ||
  "https://varyws06.enygea.com/prod/1/customer";

const VARY_USER = process.env.VARY_USER || "";
const VARY_PASSWORD = process.env.VARY_PASSWORD || "";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || "";
const VARY_CONTACT_ID = Number(process.env.VARY_CONTACT_ID || "131058"); // idContact4Log
const HTTP_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.HTTP_TIMEOUT_MS || "10000")
);

// Timeout global sur tous les appels sortants (Vary + HubSpot).
axios.defaults.timeout = HTTP_TIMEOUT_MS;

type UpsertMode = "create" | "update";

type HubSpotCompanyProps = {
  code_client_vary?: string;
  name?: string;
  address?: string;
  address2?: string;
  zip?: string;
  city?: string;
  pays__iso_?: string;
  email_client?: string;
  phone?: string;
  mobilephone?: string;
  mailing_key_vary?:
  | string
  | number[]
  | Array<{ nKey?: number | string; nValue?: number | string }>;
  particulier?: boolean | string | number;
  siret?: string;
  code_tva?: string;
  langue?: string;
  email_facture?: string;
  credit_safe_delai_paiement?: string;
  credit_safe_limit_score?: number | string;
};

/**
 * ================= Utils =================
 */
const EMAIL_RE =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const isTruthy = (v: any): boolean => {
  const s = (v ?? "").toString().toLowerCase().trim();
  return ["true", "1", "yes", "on"].includes(s);
};

const toInt = (v: any) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

const normalizePhone = (raw?: string): string | undefined =>
  raw ? raw.replace(/[^\d+]/g, "") : undefined;

const hsVal = (node: any, key: string): any => {
  if (!node) return undefined;
  if (node.properties && typeof node.properties[key]?.value !== "undefined")
    return node.properties[key].value;
  if (typeof node[key] !== "undefined") return node[key];
  return undefined;
};

const normalizeCountryISO2 = (v?: string): string | undefined => {
  if (!v) return undefined;
  const t = v.trim().toUpperCase();
  if (["FR", "FRA", "FRANCE", "FR_FR"].includes(t)) return "FR";
  if (t.length === 2) return t;
  return t.slice(0, 2);
};

const safeError = (err: any) => {
  try {
    return {
      message: err?.message ?? "unknown",
      status: err?.response?.status,
      data: err?.response?.data,
    };
  } catch {
    return { message: "unknown" };
  }
};

const isTimeoutError = (err: any): boolean => {
  const code = (err?.code || "").toString().toUpperCase();
  const msg = (err?.message || "").toString().toLowerCase();
  return code === "ECONNABORTED" || code === "ETIMEDOUT" || msg.includes("timeout");
};

/**
 * Mailing keys
 */
const parseMailingKey = (v?: string | number[] | null): number[] => {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return [...new Set(v.map(toInt).filter((n) => n >= 1 && n <= 30))].sort(
      (a, b) => a - b
    );
  }
  return [...new Set(
    v
      .toString()
      .split(/[;,.\s]+/)
      .map(toInt)
      .filter((n) => n >= 1 && n <= 30)
  )].sort((a, b) => a - b);
};

type VaryMailingKey = { nKey: number; nValue?: number };

const parseMailingKeyObjects = (v: any): VaryMailingKey[] => {
  if (!Array.isArray(v)) return [];

  const acc = new Map<number, VaryMailingKey>();
  for (const item of v) {
    const nKey = toInt(item?.nKey ?? item);
    if (Number.isNaN(nKey) || nKey < 1 || nKey > 30) continue;

    const nValueRaw = item?.nValue;
    const nValue = toInt(nValueRaw);
    const candidate =
      Number.isNaN(nValue) ? { nKey } : { nKey, nValue };

    const existing = acc.get(nKey);
    if (!existing || typeof candidate.nValue !== "undefined") {
      acc.set(nKey, candidate);
    }
  }

  return [...acc.values()].sort((a, b) => a.nKey - b.nKey);
};

const collectMailingFromFlags = (...objs: any[]): number[] => {
  const acc = new Set<number>();
  for (const obj of objs) {
    if (!obj) continue;
    for (let i = 1; i <= 30; i++) {
      const k1 = `MAIL_${i}`;
      const k2 = `mail_${i}`;
      const v =
        obj?.[k1] ??
        obj?.[k2] ??
        hsVal(obj, k1) ??
        hsVal(obj, k2);
      if (isTruthy(v)) acc.add(i);
    }
  }
  return [...acc].sort((a, b) => a - b);
};

const deriveMailingKeys = (
  payload: any,
  assocCompany: any,
  mailingKeyField: any
): number[] => {
  // 1) Ce qui vient explicitement du payload
  const fromFieldPayload = parseMailingKey(hsVal(payload, "mailing_key_vary"));
  const fromVaryObjectsPayload = parseMailingKeyObjects(
    hsVal(payload, "MailingKeys") ?? hsVal(payload, "mailing_key_vary")
  ).map((x) => x.nKey);
  const fromFlagsPayload = collectMailingFromFlags(payload);

  const hasExplicitInPayload =
    fromFieldPayload.length > 0 ||
    fromVaryObjectsPayload.length > 0 ||
    fromFlagsPayload.length > 0;

  if (hasExplicitInPayload) {
    // Le payload devient la source de vérité : on NE REGARDE PAS assocCompany
    return [
      ...new Set([
        ...fromFieldPayload,
        ...fromVaryObjectsPayload,
        ...fromFlagsPayload,
      ]),
    ].sort((a, b) => a - b);
  }

  // 2) Pas d’info mailing dans le payload → fallback sur la company associée
  const fromFieldAssoc = parseMailingKey(
    hsVal(assocCompany, "mailing_key_vary") ?? mailingKeyField
  );
  const fromVaryObjectsAssoc = parseMailingKeyObjects(
    hsVal(assocCompany, "MailingKeys") ?? hsVal(assocCompany, "mailing_key_vary")
  ).map((x) => x.nKey);
  const fromFlagsAssoc = collectMailingFromFlags(assocCompany);

  return [
    ...new Set([
      ...fromFieldAssoc,
      ...fromVaryObjectsAssoc,
      ...fromFlagsAssoc,
    ]),
  ].sort((a, b) => a - b);
};

/**
 * SIRET :
 * - Obligatoire et contrôlé uniquement pour les clients FR avec au moins une mailing key
 * - Normalisation : on garde uniquement les chiffres
 */
const validateSIRET = (
  siret?: string,
  country?: string,
  mailingKeys: number[] = []
): boolean => {
  const isFR = (country || "").toUpperCase() === "FR";
  const hasMailing = mailingKeys.length > 0;
  if (!isFR || !hasMailing) return true;

  const onlyDigits = (siret ?? "").replace(/\D/g, "");
  return /^\d{14}$/.test(onlyDigits);
};

/**
 * Résolution code client
 */
function resolveVaryCode(payload: any, query: any, assocCompany?: any): string | undefined {
  const pick = (...paths: (string | [any, string])[]) => {
    for (const p of paths) {
      if (Array.isArray(p)) {
        const [obj, key] = p;
        const v = obj?.[key] ?? obj?.properties?.[key]?.value;
        if (typeof v === "string" && v.trim()) return v.trim();
      } else {
        const v =
          payload?.[p] ??
          payload?.properties?.[p]?.value ??
          assocCompany?.[p] ??
          assocCompany?.properties?.[p]?.value ??
          query?.[p];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
    return undefined;
  };

  return pick(
    "code_client_vary",
    "customerCode",
    "sCustomerCode",
    "customer_code",
    "codeClient",
    "code_client"
  );
}

function extractVaryCode(result: any): string | undefined {
  return (
    result?.sCustomerCode ||
    result?.customerCode ||
    result?.CODECLIENT ||
    result?.codeclient ||
    result?.data?.sCustomerCode
  )?.toString();
}

function extractVaryId(result: any): string | undefined {
  return (
    result?.idCustomer ||
    result?.idCompany
  )?.toString();
}

async function getVaryCustomerByCode(customerCode: string, token: string): Promise<any | undefined> {
  const response = await axios.get(VARY_CUSTOMER_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params: {
      nPageNumber: 1,
      nPageSize: 20,
      sCustomerCode: String(customerCode).trim(),
    },
    validateStatus: () => true,
  });
  return response.data;
}

/**
 * ============== Vary / HubSpot API ==============
 */
async function getVaryAuthToken(user: string, password: string): Promise<string> {
  const response = await axios.post(
    VARY_API_URL,
    { user, password, type: "" },
    { headers: { "Content-Type": "application/json" } }
  );
  if (response.status !== 200 || !response.data?.Token) {
    throw new Error("Token Vary non reçu");
  }
  return response.data.Token;
}

// PATCH V1
async function updateVaryCustomerByCode(
  customerData: object,
  customerCode: string,
  token: string
): Promise<object> {
  const url = `${VARY_CUSTOMER_URL}/${encodeURIComponent(customerCode)}`;

  const response = await axios.patch(url, customerData, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    params: { idContact4Log: VARY_CONTACT_ID },
    validateStatus: () => true,
  });

  if (response.status === 404) {
    const err: any = new Error("Customer not found");
    err.response = { status: 404, data: response.data };
    throw err;
  }

  if (response.status !== 200) {
    throw new Error(`Erreur PATCH client: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function createVaryCustomer(customerData: object, token: string): Promise<object> {
  const response = await axios.post(VARY_CUSTOMER_URL, customerData, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });

  if (![200, 201].includes(response.status)) {
    throw new Error(`Erreur création client: ${response.status}`);
  }
  return response.data;
}

async function updateHubSpotCompany(companyId: string, properties: Record<string, any>): Promise<object> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");

  const url = `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}`;

  const response = await axios.patch(
    url,
    { properties },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Erreur update HubSpot company: ${response.status}`);
  }
  return response.data;
}

/**
 * CORS
 */
function withCORS(handler: (req: Request, res: Response) => Promise<any>) {
  return async (req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(204).send("");

    await handler(req, res);
  };
}

/**
 * =========================================================
 * HTTP — Upsert Client Vary (CREATE/UPDATE) + MAJ HubSpot
 * =========================================================
 */
functions.http(
  "hubspotVaryCustomersProd",
  withCORS(async (req: Request, res: Response) => {
    try {
      const payload =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, any>)
          : {};
      const assocCompany =
        payload["associated-company"] || payload.associatedCompany;

      console.log("customer-upsert build v2025-V1-API-mapping");
      console.log("HTTP timeout (ms):", HTTP_TIMEOUT_MS);
      console.log("Payload keys:", Object.keys(payload || {}));
      /**
       * 1) Construction des props à partir du payload et de la company associée
       */
      let p: HubSpotCompanyProps = {
        code_client_vary: hsVal(payload, "code_client_vary"),
        name:
          hsVal(payload, "name") ||
          hsVal(payload, "sName") ||
          hsVal(payload, "sDescr") ||
          hsVal(payload, "descr_name"),
        address: hsVal(payload, "address") || hsVal(payload, "sAddressLine1"),
        address2: hsVal(payload, "address2") || hsVal(payload, "sAddressLine2"),
        zip:
          hsVal(payload, "zip") ||
          hsVal(payload, "sCodepost") ||
          hsVal(payload, "sZipCode"),
        city: hsVal(payload, "city") || hsVal(payload, "sCity"),
        pays__iso_:
          hsVal(payload, "pays__iso_") ||
          hsVal(payload, "country") ||
          hsVal(payload, "sCodepays"),
        email_client: hsVal(payload, "email_client") || hsVal(payload, "sEmail"),
        phone: hsVal(payload, "phone") || hsVal(payload, "sPhone"),
        mobilephone: hsVal(payload, "mobilephone") || hsVal(payload, "sGSM"),
        mailing_key_vary:
          hsVal(payload, "mailing_key_vary") ?? hsVal(payload, "MailingKeys"),
        particulier: hsVal(payload, "particulier") ?? hsVal(payload, "bParticulier"),
        siret: hsVal(payload, "siret") || hsVal(payload, "sSiret"),
        code_tva: hsVal(payload, "code_tva") || hsVal(payload, "sCodeTVA"),
        langue:
          hsVal(payload, "langue") ||
          hsVal(payload, "sCodelang") ||
          hsVal(payload, "scodelang"),
        email_facture:
          hsVal(payload, "email_facture") || hsVal(payload, "sEmailInvoice"),
        credit_safe_delai_paiement: hsVal(payload, "credit_safe_delai_paiement"),
        credit_safe_limit_score: hsVal(payload, "credit_safe_limit_score"),
      };

      if (assocCompany && assocCompany.properties) {
        p = {
          code_client_vary:
            hsVal(assocCompany, "code_client_vary") ?? p.code_client_vary,
          name: hsVal(assocCompany, "name") ?? p.name,
          address: hsVal(assocCompany, "address") ?? p.address,
          address2: hsVal(assocCompany, "address2") ?? p.address2,
          zip: hsVal(assocCompany, "zip") ?? p.zip,
          city: hsVal(assocCompany, "city") ?? p.city,
          pays__iso_:
            hsVal(assocCompany, "pays__iso_") ||
            hsVal(assocCompany, "country") ||
            p.pays__iso_,
          email_client: hsVal(assocCompany, "email_client") ?? p.email_client,
          phone: hsVal(assocCompany, "phone") ?? p.phone,
          mobilephone: hsVal(assocCompany, "mobilephone") ?? p.mobilephone,
          mailing_key_vary:
            hsVal(assocCompany, "mailing_key_vary") ?? p.mailing_key_vary,
          particulier: hsVal(assocCompany, "particulier") ?? p.particulier,
          siret: hsVal(assocCompany, "siret") ?? p.siret,
          code_tva: hsVal(assocCompany, "code_tva") ?? p.code_tva,
          langue: hsVal(assocCompany, "langue") ?? p.langue,
          email_facture: hsVal(assocCompany, "email_facture") ?? p.email_facture,
          credit_safe_delai_paiement:
            hsVal(assocCompany, "credit_safe_delai_paiement") ??
            p.credit_safe_delai_paiement,
          credit_safe_limit_score:
            hsVal(assocCompany, "credit_safe_limit_score") ??
            p.credit_safe_limit_score,
        };
      }

      /**
       * 2) Validation
       */
      const name = (p.name || "").toString().trim();
      if (!name) {
        return res.status(400).json({
          message: "Missing required 'name' (sName/DESCR).",
        });
      }

      const countryISO =
        normalizeCountryISO2(
          p.pays__iso_ || hsVal(payload, "country") || hsVal(payload, "sCodepays")
        ) || "";
      const mailingKeys = deriveMailingKeys(
        payload,
        assocCompany,
        p.mailing_key_vary
      );

      const isFR = countryISO === "FR";
      const missing: string[] = [];

      if (!p.email_facture) missing.push("email_facture");
      if (mailingKeys.length === 0) missing.push("mailing_key_vary");
      if (isFR && mailingKeys.length > 0 && !p.siret) missing.push("siret");

      if (missing.length) {
        return res.status(400).json({
          message: "Champs obligatoires manquants",
          required: [
            "email_facture",
            "mailing_key_vary",
            "siret (FR + mailing key)",
          ],
          missing,
          debug: {
            pays__iso_: countryISO,
            siret_present: !!p.siret,
            email_facture_present: !!p.email_facture,
            mailing_keys_count: mailingKeys.length,
            mailing_keys: mailingKeys,
          },
        });
      }

      if (p.email_client && !EMAIL_RE.test(p.email_client)) {
        return res.status(400).json({ message: "Invalid email_client" });
      }

      if (p.email_facture && !EMAIL_RE.test(p.email_facture)) {
        return res.status(400).json({ message: "Invalid email_facture" });
      }

      if (!validateSIRET(p.siret, countryISO, mailingKeys)) {
        return res.status(400).json({
          message:
            "Invalid or missing SIRET for FR customers with Mailing Key",
        });
      }

      /**
       * 3) Payload Vary V1
       */
      const siretDigits = p.siret
        ? p.siret.replace(/\D/g, "")
        : undefined;

      const paymentConditions =
        (p.credit_safe_delai_paiement || "").toString().trim() || undefined;
      const description =
        (
          hsVal(payload, "sDescr") ||
          hsVal(payload, "descr_name") ||
          name
        )
          .toString()
          .trim() || name;
      const varyLanguage =
        (
          p.langue ||
          hsVal(payload, "sCodelang") ||
          hsVal(payload, "scodelang") ||
          countryISO
        )
          .toString()
          .trim()
          .toUpperCase() || undefined;
      const mailingKeysFromPayload = parseMailingKeyObjects(
        hsVal(payload, "MailingKeys") ?? hsVal(payload, "mailing_key_vary")
      );
      const mailingKeysForVary =
        mailingKeysFromPayload.length > 0
          ? mailingKeysFromPayload
          : mailingKeys.map((n) => ({ nKey: n }));

      const creditLimitScoreRaw = p.credit_safe_limit_score;
      const parsedCreditLimit = toInt(creditLimitScoreRaw);
      const nCreditLimitAmount =
        Number.isNaN(parsedCreditLimit) || parsedCreditLimit <= 0
          ? 1250 // fallback par défaut si la valeur HS est absente ou invalide
          : parsedCreditLimit;



      const customerData: Record<string, any> = {
        //sName: name,
        sDescr: description,
        /*
        sCodelang: varyLanguage,
        sCodepost: p.zip,
        sZipCode: p.zip,
        sCodepays: countryISO,
        sAddressLine1: p.address,
        sAddressLine2: p.address2,
        sCity: p.city,
        sSiret: siretDigits,
        sCodeTVA: p.code_tva,
        sEmail: p.email_client,
        sPhone: normalizePhone(p.phone),
        sGSM: normalizePhone(p.mobilephone || p.phone),
        sEmailInvoice: p.email_facture,
        bParticulier: isTruthy(p.particulier),
        nPrivatePerson: isTruthy(p.particulier) ? 1 : 0,
        ...(mailingKeysForVary.length
          ? { MailingKeys: mailingKeysForVary }
          : {}),

        // 👉 nouveaux champs demandés par Vary
        sPaymentConditions: paymentConditions,          // ce que Vary utilise pour la condition de paiement
        credit_safe_delai_paiement: paymentConditions,  // trace brute de la valeur HubSpot
        nCreditlimitActive: 1,                          // valeur par défaut
        nCreditLimitAmount: nCreditLimitAmount,  // 👈 désormais basé sur credit_safe_limit_score
        nInvoiceSendMethod: 2,
        */

      };

      console.log("Payload envoyé à Vary V1:", customerData);

      /**
       * 4) Mode update/create
       */
      const resolvedVaryCode = resolveVaryCode(payload, req.query, assocCompany);
      const mode: UpsertMode = resolvedVaryCode ? "update" : "create";

      console.log("Mode choisi:", mode, "resolvedVaryCode:", resolvedVaryCode);

      /**
       * 5) Auth + upsert
       */
      console.log("Step 5.1 - get Vary auth token");
      let token = await getVaryAuthToken(VARY_USER, VARY_PASSWORD);
      console.log("Step 5.1 - token reçu");

      let result: any;
      if (mode === "update") {
        // log CURL pour debug support Vary
        const curlBody = JSON.stringify(customerData).replace(/"/g, '\\"');
        const safeToken =
          token.length > 12
            ? `${token.slice(0, 6)}...${token.slice(-4)}`
            : "***";
        const curl = `
        curl -X PATCH "${VARY_CUSTOMER_URL}/${encodeURIComponent(
          resolvedVaryCode as string
        )}?idContact4Log=${VARY_CONTACT_ID}" \\
          -H "Authorization: Bearer ${safeToken}" \\
          -H "Content-Type: application/json" \\
          -d "${curlBody}"
          `;
        console.log("===== CURL TO SEND TO VARY SUPPORT =====");
        console.log(curl);
        console.log("========================================");

        console.log("Step 5.2 - PATCH customer start");
        result = await updateVaryCustomerByCode(
          customerData,
          resolvedVaryCode as string,
          token
        );
        console.log("Step 5.2 - PATCH customer success");
      } else {
        console.log("Step 5.2 - CREATE customer start");
        result = await createVaryCustomer(customerData, token);
        console.log("Step 5.2 - CREATE customer success");
      }

      /**
       * 6) GET juste après pour vérifier la valeur modifiée
       *    - on récupère un code client fiable
       *    - on fait un GET par sCustomerCode
       *    - on log + renvoie dans la réponse
       */
      const codeAfterUpsert =
        extractVaryCode(result) ||
        resolvedVaryCode ||
        p.code_client_vary;

      let verify: any = null;
      const idFromPayloadOrAssoc =
        hsVal(payload, "id_vary") || hsVal(assocCompany, "id_vary");
      let id_vary: string | undefined =
        extractVaryId(result) ||
        (idFromPayloadOrAssoc ? String(idFromPayloadOrAssoc) : undefined);

      const verifyAfterUpsertEnabled = isTruthy(
        process.env.VARY_VERIFY_AFTER_UPSERT
      );

      if (codeAfterUpsert && !id_vary && verifyAfterUpsertEnabled) {
        console.log("Step 6 - VerifyAfterUpsert start", {
          codeAfterUpsert,
        });
        verify = await getVaryCustomerByCode(String(codeAfterUpsert), token);
        console.log(
          "VerifyAfterUpsert:",
          JSON.stringify(verify, null, 2)
        );

        const firstCustomer = verify?.Customers?.[0] ?? verify;
        id_vary = extractVaryId(firstCustomer);
      } else {
        console.log("Step 6 - VerifyAfterUpsert skipped", {
          reason: !codeAfterUpsert
            ? "missing_code"
            : id_vary
              ? "id_already_known"
              : "disabled_by_env",
          codeAfterUpsert,
          verifyAfterUpsertEnabled,
        });
      }

      // 7) MAJ HubSpot avec code_client_vary / id_vary
      const candidateCompanyId =
        payload.companyId ||
        payload.objectId ||
        payload.company_id ||
        payload.hs_object_id ||
        assocCompany?.id ||
        assocCompany?.companyId ||
        assocCompany?.objectId ||
        hsVal(assocCompany, "hs_object_id");

      console.log("HubSpot update - candidateCompanyId:", candidateCompanyId);
      console.log("HubSpot update - codeAfterUpsert:", codeAfterUpsert);
      console.log("HubSpot update - id_vary:", id_vary);

      let hubspotUpdate: any = null;
      let hubspotUpdateError: any = null;
      const currentCodeClientVary =
        hsVal(payload, "code_client_vary") || hsVal(assocCompany, "code_client_vary");
      const currentIdVary =
        hsVal(payload, "id_vary") || hsVal(assocCompany, "id_vary");

      if (candidateCompanyId && (codeAfterUpsert || id_vary)) {
        try {
          const hsProps: Record<string, any> = {};
          if (
            id_vary &&
            String(currentIdVary || "").trim() !== String(id_vary).trim()
          ) {
            hsProps.id_vary = String(id_vary);
          }
          if (
            codeAfterUpsert &&
            String(currentCodeClientVary || "").trim() !==
            String(codeAfterUpsert).trim()
          ) {
            hsProps.code_client_vary = String(codeAfterUpsert);
          }

          if (!Object.keys(hsProps).length) {
            console.log("HubSpot update - skipped (no property change)");
          } else {
            console.log(
              "HubSpot update - sending patch on company",
              String(candidateCompanyId),
              "with properties",
              hsProps
            );

            hubspotUpdate = await updateHubSpotCompany(
              String(candidateCompanyId),
              hsProps
            );
            console.log("HubSpot update - success");
          }
        } catch (e: any) {
          hubspotUpdateError = safeError(e);
          console.error("HubSpot update - error:", hubspotUpdateError);
        }
      } else {
        console.warn(
          "HubSpot update SKIPPED - missing candidateCompanyId or no code/id_vary",
          { candidateCompanyId, codeAfterUpsert, id_vary }
        );
      }


      return res.status(mode === "update" ? 200 : 201).json({
        message: mode === "update"
          ? "Client modifié avec succès"
          : "Client créé avec succès",
        vary_customer: result,          // réponse brute du POST/PATCH
        sent_payload: customerData,     // ce qu’on a envoyé à Vary
        verify_after_upsert: verify,    // résultat du GET juste après
        hubspot_update: hubspotUpdate,
        hubspot_update_error: hubspotUpdateError,
        hubspot_company_id_used: candidateCompanyId ?? null,
        hubspot_code_client_vary_sent: codeAfterUpsert ?? null,
      });
    } catch (err) {
      const details = safeError(err);
      const status = isTimeoutError(err) ? 504 : 500;
      console.error("Error:", details);
      return res.status(status).json({
        message: isTimeoutError(err)
          ? "Timeout lors de l'appel API externe"
          : "Erreur lors de l’upsert client",
        details,
      });
    }
  })
);
