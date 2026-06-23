import * as functions from "@google-cloud/functions-framework";
import axios from "axios";
import { Request, Response } from "@google-cloud/functions-framework";

/**
 * =============================
 * Environnement (TEST)
 * =============================
 */
const VARY_API_URL = process.env.VARY_API_URL || "https://varyws05.enygea.com/test/1/auth/token";
const VARY_CUSTOMER_URL = process.env.VARY_CUSTOMER_URL || "https://varyws05.enygea.com/test/1/customer";
const VARY_USER = process.env.VARY_USER || "";
const VARY_PASSWORD = process.env.VARY_PASSWORD || "";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || "";
const VARY_CONTACT_ID = Number(process.env.VARY_CONTACT_ID || "137783"); // idContact4Log si requis

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
  mailing_key_vary?: string | number[];
  particulier?: boolean | string | number;
  siret?: string;
  code_tva?: string;
  langue?: string;
  email_facture?: string;
};

/** ================= Utils ================= */
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const isTruthy = (v: any): boolean =>
  [true, "true", 1, "1", "yes", "on"].includes((v ?? "").toString().toLowerCase());
const toInt = (v: any) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const normalizePhone = (raw?: string): string | undefined => (raw ? raw.replace(/[^\d+]/g, "") : undefined);

const hsVal = (node: any, key: string): any => {
  if (!node) return undefined;
  if (node.properties && typeof node.properties[key]?.value !== "undefined")
    return node.properties[key].value;
  if (typeof node[key] !== "undefined") return node[key];
  return undefined;
};

const parseMailingKey = (v?: string | number[] | null): number[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return [...new Set(v.map(toInt).filter((n) => n >= 1 && n <= 30))].sort((a, b) => a - b);
  return [...new Set(v.toString().split(/[;,.\s]+/).map(toInt).filter((n) => n >= 1 && n <= 30))].sort((a, b) => a - b);
};
const collectMailingFromFlags = (...objs: any[]): number[] => {
  const acc = new Set<number>();
  for (const obj of objs) {
    if (!obj) continue;
    for (let i = 1; i <= 30; i++) {
      const k1 = `MAIL_${i}`, k2 = `mail_${i}`;
      const v = obj?.[k1] ?? obj?.[k2] ?? hsVal(obj, k1) ?? hsVal(obj, k2);
      if (isTruthy(v)) acc.add(i);
    }
  }
  return [...acc].sort((a, b) => a - b);
};
const deriveMailingKeys = (payload: any, assocCompany: any, mailingKeyField: any): number[] => {
  const fromField = parseMailingKey(mailingKeyField);
  const fromFlags = collectMailingFromFlags(payload, assocCompany);
  return [...new Set([...fromField, ...fromFlags])].sort((a, b) => a - b);
};
const normalizeCountryISO2 = (v?: string): string | undefined => {
  if (!v) return undefined;
  const t = v.trim().toUpperCase();
  if (["FR", "FRA", "FRANCE", "FR_FR"].includes(t)) return "FR";
  if (t.length === 2) return t;
  return t.slice(0, 2);
};
const validateSIRET = (siret?: string, country?: string, mailingKeys: number[] = []): boolean => {
  const isFR = (country || "").toUpperCase() === "FR";
  const hasMailing = mailingKeys.length > 0;
  if (isFR && hasMailing) return /^\d{14}$/.test(siret ?? "");
  return true;
};
const safeError = (err: any) => {
  try { return { message: err?.message ?? "unknown", status: err?.response?.status, data: err?.response?.data }; }
  catch { return { message: "unknown" }; }
};

function resolveVaryCode(payload: any, query: any, assocCompany?: any): string | undefined {
  const pick = (...paths: (string | [any, string])[]) => {
    for (const p of paths) {
      if (Array.isArray(p)) {
        const [obj, key] = p;
        const v = obj?.[key] ?? obj?.properties?.[key]?.value;
        if (typeof v === "string" && v.trim()) return v.trim();
      } else {
        const v =
          payload?.[p] ?? payload?.properties?.[p]?.value ??
          assocCompany?.[p] ?? assocCompany?.properties?.[p]?.value ?? query?.[p];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
    return undefined;
  };
  return pick("code_client_vary","customerCode","sCustomerCode",
              [payload?.company,"code_client_vary"],[assocCompany,"code_client_vary"],
              "customer_code","codeClient","code_client");
}
function extractVaryCode(result: any): string | undefined {
  return (
    result?.sCustomerCode || result?.customerCode || result?.CODECLIENT || result?.codeclient ||
    result?.data?.sCustomerCode || result?.data?.CODECLIENT
  )?.toString();
}
function extractVaryId(result: any): string | undefined {
  return (
    result?.idCustomer || result?.idCompany || result?.idCustomer
  )?.toString();
}

async function getVaryCustomerByCode(customerCode: string, token: string): Promise<any | undefined> {
  const response = await axios.get(VARY_CUSTOMER_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params: { nPageNumber: 1, nPageSize: 100, sCustomerCode: String(customerCode).trim() },
    validateStatus: () => true,
  });
  return response.data;
}

/** ============== Vary / HubSpot API ============== */
async function getVaryAuthToken(user: string, password: string): Promise<string> {
  const response = await axios.post(VARY_API_URL, { user, password, type: "" }, { headers: { "Content-Type": "application/json" } });
  if (response.status !== 200 || !response.data?.Token) throw new Error("Token Vary non reçu");
  return response.data.Token as string;
}
async function createVaryCustomer(customerData: object, token: string): Promise<object> {
  const response = await axios.post(VARY_CUSTOMER_URL, customerData, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (![200, 201].includes(response.status)) throw new Error(`Erreur création client: ${response.status}`);
  return response.data;
}
async function updateVaryCustomerByCode(customerData: object, customerCode: string, token: string): Promise<object> {
  const url = `${VARY_CUSTOMER_URL}/${encodeURIComponent(customerCode)}`;
  const response = await axios.patch(url, customerData, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    params: { idContact4Log: VARY_CONTACT_ID },
    validateStatus: () => true,
  });
  if (response.status === 404) {
    const err: any = new Error("Customer not found"); err.response = { status: 404, data: response.data }; throw err;
  }
  if (response.status !== 200) throw new Error(`Erreur modification client: ${response.status} ${JSON.stringify(response.data)}`);
  return response.data;
}
async function updateHubSpotCompany(companyId: string, properties: Record<string, any>): Promise<object> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const url = `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}`;
  const response = await axios.patch(url, { properties }, { headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" } });
  if (response.status < 200 || response.status >= 300) throw new Error(`Erreur update HubSpot company: ${response.status}`);
  return response.data;
}

/** ============== CORS wrapper ============== */
function withCORS(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    await handler(req, res);
  };
}

/** =========================================================
 * HTTP — Upsert Client Vary (CREATE/UPDATE) + MAJ HubSpot
 * ========================================================= */
functions.http("hubspotVaryCustomerUpsert", withCORS(async (req: Request, res: Response) => {
  try {
    const payload = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;
    const assocCompany = payload["associated-company"] || payload.associatedCompany;

    console.log("build: customer-upsert v2025-10-17-1");

    // 1) Build props
    let p: HubSpotCompanyProps = {
      code_client_vary: hsVal(payload, "code_client_vary"),
      name: hsVal(payload, "name"),
      address: hsVal(payload, "address"),
      address2: hsVal(payload, "address2"),
      zip: hsVal(payload, "zip"),
      city: hsVal(payload, "city"),
      pays__iso_: hsVal(payload, "pays__iso_") || hsVal(payload, "country"),
      email_client: hsVal(payload, "email_client"),
      phone: hsVal(payload, "phone"),
      mobilephone: hsVal(payload, "mobilephone"),
      mailing_key_vary: hsVal(payload, "mailing_key_vary"),
      particulier: hsVal(payload, "particulier"),
      siret: hsVal(payload, "siret"),
      code_tva: hsVal(payload, "code_tva"),
      langue: hsVal(payload, "langue"),
      email_facture: hsVal(payload, "email_facture"),
    };

    if (assocCompany && assocCompany.properties) {
      p = {
        code_client_vary: hsVal(assocCompany, "code_client_vary") ?? p.code_client_vary,
        name: hsVal(assocCompany, "name") ?? p.name,
        address: hsVal(assocCompany, "address") ?? p.address,
        address2: hsVal(assocCompany, "address2") ?? p.address2,
        zip: hsVal(assocCompany, "zip") ?? p.zip,
        city: hsVal(assocCompany, "city") ?? p.city,
        pays__iso_: (hsVal(assocCompany, "pays__iso_") || hsVal(assocCompany, "country")) ?? p.pays__iso_,
        email_client: hsVal(assocCompany, "email_client") ?? p.email_client,
        phone: hsVal(assocCompany, "phone") ?? p.phone,
        mobilephone: hsVal(assocCompany, "mobilephone") ?? p.mobilephone,
        mailing_key_vary: hsVal(assocCompany, "mailing_key_vary") ?? p.mailing_key_vary,
        particulier: hsVal(assocCompany, "particulier") ?? p.particulier,
        siret: hsVal(assocCompany, "siret") ?? p.siret,
        code_tva: hsVal(assocCompany, "code_tva") ?? p.code_tva,
        langue: hsVal(assocCompany, "langue") ?? p.langue,
        email_facture: hsVal(assocCompany, "email_facture") ?? p.email_facture,
      };
    }

    // 2) Validation
    const name = (p.name || "").toString().trim();
    if (!name) return res.status(400).json({ message: "Missing required 'name' (sName/DESCR)." });

    const countryISO = normalizeCountryISO2(p.pays__iso_ || hsVal(payload, "country")) || "";
    const mailingKeys = deriveMailingKeys(payload, assocCompany, p.mailing_key_vary);

    // === Champs obligatoires: SIRET + MAILING KEY + EMAIL FACTURE ===
    const missing: string[] = [];
    if (!p.siret) missing.push("siret");
    if (!p.email_facture) missing.push("email_facture");
    if (mailingKeys.length === 0) missing.push("mailing_key_vary");
    
    if (missing.length) {
      return res.status(400).json({
        message: "Champs obligatoires manquants",
        required: ["siret", "mailing_key_vary", "email_facture"],
        missing,
        debug: {
          pays__iso_: countryISO,
          siret_present: !!p.siret,
          email_facture_present: !!p.email_facture,
          mailing_keys_count: mailingKeys.length,
          mailing_keys: mailingKeys
        }
      });
    }

    if (p.email_client && !EMAIL_RE.test(p.email_client)) return res.status(400).json({ message: "Invalid email_client" });
    if (p.email_facture && !EMAIL_RE.test(p.email_facture)) return res.status(400).json({ message: "Invalid email_facture" });
    if (!validateSIRET(p.siret, countryISO, mailingKeys)) {
      return res.status(400).json({ message: "Invalid or missing SIRET for FR customers with Mailing Key" });
    }

    // 3) Payload Vary
    const customerData: Record<string, any> = {
      sName: name,
      sAddressee: name,
      sAddressLine1: p.address,
      sAddressLine2: p.address2,
      sZipCode: p.zip,
      sCity: p.city,
      sCountryCode: countryISO,
      sEmail: p.email_client,
      sPhone: normalizePhone(p.phone),
      sSiret: p.siret,
      sEmailInvoice: p.email_facture,
      nPrivatePerson: isTruthy(p.particulier) ? 1 : 0,
      sInternalReference: hsVal(payload, "internal_reference") || undefined,
      sPaymentConditions: hsVal(payload, "payment_conditions") || undefined,
      nCreditlimitActive: isTruthy(hsVal(payload, "credit_limit_active")) ? 1 : 0,
      nCreditLimitAmount: Number(hsVal(payload, "credit_limit_amount")) || undefined,
      ...(mailingKeys.length ? { MailingKeys: mailingKeys.map((n) => ({ nKey: n })) } : {}),
    };

    // 4) Décision update/create
    const resolvedVaryCode = resolveVaryCode(payload, req.query, assocCompany);
    const mode: UpsertMode = resolvedVaryCode ? "update" : "create";

    // 4.1) Vary create/update
    const token = await getVaryAuthToken(VARY_USER, VARY_PASSWORD);
    let result: any;
    try {
      result = resolvedVaryCode
        ? await updateVaryCustomerByCode(customerData, resolvedVaryCode, token)
        : await createVaryCustomer(customerData, token);
    } catch (e: any) {
      if (resolvedVaryCode && e?.response?.status === 404) {
        result = await createVaryCustomer(customerData, token);
      } else {
        throw e;
      }
    }

    // 5) MAJ HubSpot
    const candidateCompanyId =
      payload.companyId || payload.objectId || payload.company_id || payload.hs_object_id ||
      (assocCompany?.id || assocCompany?.companyId || assocCompany?.objectId || hsVal(assocCompany, "hs_object_id"));

    const varyCodeClient =
      extractVaryCode(result) ||
      p.code_client_vary ||
      resolvedVaryCode;

    // Optionnel: récupérer idCustomer via GET by code si on a bien un code
    let id_vary: string | undefined = undefined;
    if (varyCodeClient) {
      const lookup = await getVaryCustomerByCode(String(varyCodeClient), token);
      id_vary = extractVaryId(lookup?.Customers?.[0] || lookup?.Customers?.[0]);
    }

    console.log("We got this id_vary " + id_vary);
    console.log("We got this varyCodeClient " + varyCodeClient);

    let hubspotUpdate: any = null;
    let hubspotUpdateError: any = null;
    if (candidateCompanyId && (varyCodeClient || id_vary)) {
      try {
        const hsProps: Record<string, any> = {};
        if (id_vary) hsProps.idclient_vary = String(id_vary);
        if (varyCodeClient) hsProps.code_client_vary = String(varyCodeClient);

        if (Object.keys(hsProps).length) {
          hubspotUpdate = await updateHubSpotCompany(String(candidateCompanyId), hsProps);
        }
      } catch (e: any) {
        hubspotUpdateError = safeError(e);
      }
    }

    return res.status(resolvedVaryCode ? 200 : 201).json({
      message: resolvedVaryCode ? "Client modifié avec succès" : "Client créé avec succès",
      vary_customer: result,
      sent_payload: customerData,
      hubspot_update: hubspotUpdate,
      hubspot_update_error: hubspotUpdateError,
      hubspot_company_id_used: candidateCompanyId ?? null,
      hubspot_code_client_vary_sent: varyCodeClient ?? null,
    });
  } catch (error: any) {
    return res.status(500).json({ message: "Erreur lors de l’upsert client", details: safeError(error) });
  }
}));
