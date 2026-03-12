import * as functions from "@google-cloud/functions-framework";
import axios from "axios";
import { Request, Response } from "@google-cloud/functions-framework";

// =============================
// Environment configuration
// =============================
const VARY_API_URL = process.env.VARY_API_URL || "https://varyws06.enygea.com/prod/1/auth/token";
const VARY_CONTACT_URL = process.env.VARY_CONTACT_URL || process.env.VARY_TASK_URL || "https://varyws06.enygea.com/prod/1/contact";
const VARY_CUSTOMER_URL = process.env.VARY_CUSTOMER_URL || "https://varyws06.enygea.com/prod/1/customer"; // for lookup by SIRET
const VARY_USER = process.env.VARY_USER || "";
const VARY_PASSWORD = process.env.VARY_PASSWORD || "";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || "";

// =============================
// Types
// =============================
type UpsertMode = "create" | "update";

type Consent = {
  idConsent: number; // 1,4,5,6
  nConsentAnswer: number; // 1 = NO, 2 = YES
  dDate: string; // YYYYMMDD
  tTime: string; // HHMM
};

// =============================
// Helpers
// =============================
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const isTruthy = (v: any): boolean => [true, "true", 1, "1", "yes", "on"].includes((v ?? "").toString().toLowerCase());
const normalizePhone = (raw?: string): string | undefined => (raw ? raw.replace(/[^\d+]/g, "") : undefined);
const EGRESS_IP_TTL_MS = Math.max(60_000, Number(process.env.EGRESS_IP_TTL_MS || "300000"));
let cachedEgressIp: string | null = null;
let cachedEgressIpAt = 0;

// Read HubSpot legacy payloads: properties.{key}.value or flat
const hsVal = (node: any, key: string): any => {
  if (!node) return undefined;
  if (node.properties && node.properties[key] && typeof node.properties[key].value !== "undefined") {
    return node.properties[key].value;
  }
  if (typeof node[key] !== "undefined") return node[key];
  return undefined;
};

const mapLanguageToVary = (v?: string): string | undefined => {
  if (!v) return undefined;
  const t = v.toString().trim().toLowerCase();
  if (["fr", "f", "fra", "fr_fr"].includes(t)) return "F";
  if (["en", "eng", "en_gb", "en_us"].includes(t)) return "EN";
  if (["es", "spa"].includes(t)) return "ES";
  if (["it", "ita"].includes(t)) return "IT";
  if (["nl", "nld", "dut"].includes(t)) return "NL";
  if (["pt", "por", "pt_pt", "pt_br"].includes(t)) return "PT";
  return v.toString().toUpperCase();
};

const parseTypeDeContact = (v: any): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const s = v.toString().trim().toLowerCase();
  if (/^[0-3]$/.test(s)) return Number(s);
  if (s.includes("achat")) return 1;
  if (s.includes("terrain")) return 2;
  if (s.includes("compta") || s.includes("accounting") || s.includes("finance")) return 3;
  return 0; // Rien
};

// =============================
// Vary API helpers
// =============================
async function getVaryAuthToken(user: string, password: string): Promise<string> {
  const requestData = { user, password, type: "" };
  const headers = { "Content-Type": "application/json" };

  // --- DEBUG LOG pour copier/coller dans Postman ---
  console.log("=== CURL TO REPRODUCE ===");
  console.log(
    `curl -X POST '${VARY_API_URL}' \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(requestData)}'`
  );
  console.log("=== END CURL ===");

  const response = await axios.post(VARY_API_URL, requestData, { headers });
  if (response.status !== 200 || !response.data?.Token) {
    throw new Error("Token Vary non reçu");
  }
  return response.data.Token as string;
}

async function createVaryContact(contactData: object, token: string): Promise<object> {
  const response = await axios.post(VARY_CONTACT_URL, contactData, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
  if (![200, 201].includes(response.status)) throw new Error(`Erreur création contact: ${response.status}`);
  return response.data;
}

async function updateVaryContact(contactData: object, vary_id: string, token: string): Promise<object> {
  const response = await axios.patch(`${VARY_CONTACT_URL}/${vary_id}`, contactData, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
  if (response.status !== 200) throw new Error(`Erreur modification contact: ${response.status}`);
  return response.data;
}

// Build LinksCustomers from HubSpot associated company SIRETs
async function getCompaniesSIRETFromHubSpot(contactId: string): Promise<string[]> {
  try {
    // associations contacts->companies
    const associationUrl = `https://api.hubapi.com/crm/v3/associations/contacts/companies/batch/read`;
    const associationResponse = await fetch(associationUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: [{ id: contactId }] }),
    });
    if (!associationResponse.ok) throw new Error(`HTTP ${associationResponse.status}: ${await associationResponse.text()}`);

    const associationData = await associationResponse.json();
    const companyIds: string[] = associationData.results?.flatMap((assoc: any) => assoc.to?.map((c: any) => c.id)) || [];
    if (companyIds.length === 0) return [];

    // batch read companies
    const companyUrl = `https://api.hubapi.com/crm/v3/objects/companies/batch/read`;
    const companyResponse = await fetch(companyUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: ["siret"], inputs: companyIds.map((id: string) => ({ id })) }),
    });
    if (!companyResponse.ok) throw new Error(`HTTP ${companyResponse.status}: ${await companyResponse.text()}`);
    const companyData = await companyResponse.json();

    return (companyData.results || [])
      .map((company: any) => company.properties?.siret)
      .filter((s: any) => typeof s === "string" && s.trim().length > 0);
  } catch (e) {
    console.error("Erreur HubSpot companies/SIRET:", e);
    return [];
  }
}

async function getVaryCustomersBySIRET(siretNumbers: string[], token: string): Promise<any[]> {
  const results: Array<{ idCodeClient: number | string; Action: "ADD" | "DEL" }> = [];
  for (const siret of siretNumbers) {
    try {
      const response = await axios.get(`${VARY_CUSTOMER_URL}?nPageNumber=1&nPageSize=50&sSIRET=${encodeURIComponent(siret)}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const customer = response.data?.Customers?.[0];
      if (customer?.idCustomer) results.push({ idCodeClient: customer.idCustomer, Action: "ADD" });
    } catch (error: any) {
      console.error(`Erreur Vary customer lookup SIRET ${siret}:`, error?.response?.data || error?.message || error);
    }
  }
  return results;
}


function parseIdList(input: any): number[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n));
  }
  return String(input)
    .split(/[;\s,]+/)
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}




function buildConsentsFromHubSpot(opts: {
  optInIds?: any;   // hérité (optionnel)
  optOutIds?: any;  // "désabonnements" (prioritaire)
}): Consent[] {
  const ids = [1, 4, 5, 6];

  const optOut = new Set(parseIdList(opts.optOutIds)); // priorité
  // optIn gardé pour compat, mais comme défaut = YES, il n'a pas d'effet restrictif
  // (on le conserve si tu veux tracer/valider l'input)
  // const optIn  = new Set(parseIdList(opts.optInIds));

  const now = new Date();
  const dDate = now.toISOString().slice(0, 10);   // YYYY-MM-DD
  const tTime = now.toTimeString().slice(0, 5);   // HH:mm

  return ids.map((id) => ({
    idConsent: id,
    // DEFAULT = YES (2). Si l'id est présent dans les désabonnements => NO (1)
    nConsentAnswer: optOut.has(id) ? 1 : 2,
    dDate,
    tTime,
  }));
}

function safeError(err: any) {
  try {
    return { message: err?.message ?? "unknown", status: err?.response?.status, data: err?.response?.data };
  } catch (_) {
    return { message: "unknown" };
  }
}

async function getCloudFunctionEgressIp(): Promise<string | null> {
  const now = Date.now();
  if (cachedEgressIp && now - cachedEgressIpAt < EGRESS_IP_TTL_MS) {
    return cachedEgressIp;
  }

  try {
    const resp = await axios.get("https://api.ipify.org?format=json", {
      timeout: 2500,
      validateStatus: () => true,
    });

    const ip = resp?.data?.ip;
    if (resp.status >= 200 && resp.status < 300 && typeof ip === "string" && ip.trim()) {
      cachedEgressIp = ip.trim();
      cachedEgressIpAt = now;
      return cachedEgressIp;
    }
  } catch (e: any) {
    console.warn("Impossible de récupérer l'IP sortante:", e?.message || e);
  }

  return null;
}

// =============================
// HTTP Function — Upsert Contact (Vary /contact)
// =============================
functions.http("hubspotVaryContactProd", async (req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");

  const egressIpPromise = getCloudFunctionEgressIp();
  egressIpPromise
    .then((ip) => console.log("cloud_function_egress_ip:", ip ?? "unavailable"))
    .catch((e: any) => console.warn("cloud_function_egress_ip_error:", e?.message || e));

  try {
    const payload = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;

    const hubspot_id = (payload.hubspot_id ?? hsVal(payload, "hs_object_id") ?? hsVal(payload, "vid") ?? req.query?.hubspot_id)?.toString();
    const vary_id = (payload.vary_id ?? req.query?.vary_id ?? hsVal(payload, "id_contact"))?.toString();
    const mode: UpsertMode = vary_id ? "update" : "create";


    // ---- Read contact fields from HS payload ----
    const firstName = (hsVal(payload, "firstname") || hsVal(payload, "firstName") || payload.firstName || payload.firstname || "").toString().trim();
    const lastName = (hsVal(payload, "lastname") || hsVal(payload, "lastName") || payload.lastName || payload.lastname || "").toString().trim();
    const email = (hsVal(payload, "email") || payload.email || "").toString().trim();
    const phone = normalizePhone(hsVal(payload, "phone") || payload.phone);
    const mobile = normalizePhone(hsVal(payload, "mobilephone") || hsVal(payload, "mobilphone") || payload.mobilephone || payload.mobilphone);
    const title = (hsVal(payload, "title") || payload.title || "").toString().trim(); // civilité
    const jobtitle = (hsVal(payload, "jobtitle") || payload.jobtitle || "").toString().trim(); // fonction
    const hsLang = (hsVal(payload, "hs_language") || payload.hs_language || "").toString();
    const varyLang = mapLanguageToVary(hsLang);
    const typeDeContact = parseTypeDeContact(hsVal(payload, "type_de_contact") ?? payload.type_de_contact);

    const overrideRaw = (hsVal(payload, "contact_bloque") ?? payload.contact_bloque ?? req.query?.contact_bloque);

    console.log(hsVal(payload, "contact_bloque"));
    console.log("overrideRaw " + overrideRaw);
    // "hasOverride" = il y a vraiment une valeur fournie (ni undefined, ni null, ni string vide)
    const hasOverride =
      typeof overrideRaw !== "undefined" &&
      overrideRaw !== null &&
      String(overrideRaw).trim() !== "";

    // si override fourni => on suit strictement ; sinon => false (ne bloque pas)
    const isBlocked = hasOverride ? isTruthy(overrideRaw) : false;

    console.log("isBlocked" + isBlocked);
    // Consents
    const hsDesabonnements =
      hsVal(payload, "desabonnements") ??
      payload.desabonnements ??
      req.query?.desabonnements;

    const hsConsentOptIn =
      hsVal(payload, "consent") ??
      payload.consent ??
      req.query?.consent;

    // LinksCustomers from SIRET (associated companies)
    let linksCustomers: any[] = [];
    if (hubspot_id) {
      const tokenTmp = await getVaryAuthToken(VARY_USER, VARY_PASSWORD);
      //const tokenTmp = "TQBAAGsArCBUAGgAMwBHAHIANABkAEUAfAA3ADIANwA1ADQANAA1ADcAfAAyADAAMgA1ADAANAAwADgAMAA5ADQANQAyADUAOQA5ADgA";

      const sirets = await getCompaniesSIRETFromHubSpot(hubspot_id);
      linksCustomers = await getVaryCustomersBySIRET(sirets, tokenTmp);
    }

    // ---- Minimal required checks ----
    if (!lastName && !email) {
      return res.status(400).json({
        message: "Missing required identity: provide at least lastname or email",
        cloud_function_egress_ip: await egressIpPromise,
      });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({
        message: "Invalid email format",
        cloud_function_egress_ip: await egressIpPromise,
      });
    }

    console.log("We are going to : " + mode + " the contact (" + vary_id + ") with the HubSpot ID (" + hubspot_id + ") and the name (" + firstName + " " + lastName + ") and the email (" + email + " )");
    // ---- Build Vary contact payload ----
    const contactData: Record<string, any> = {
      // API-friendly keys (observed patterns)
      sFirstName: firstName || undefined,
      sLastName: lastName || undefined,
      sEmail: email || undefined,
      sPhone: phone || undefined,
      sMobile: mobile || undefined,
      sTitle: title || undefined, // civilité
      //sFunct: jobtitle || undefined, // fonction
      //sFunction: jobtitle || undefined, // fonction
      sLanguage: varyLang || undefined,

      // DB-like keys (from client CSV mapping) — keep both to be safe
      FIRSTNAME: firstName || undefined,
      LASTNAME: lastName || undefined,
      EMAIL: email || undefined,
      TELEPHONE: phone || undefined,
      GSM: mobile || undefined,
      TITLE: title || undefined,
      FUNCT: jobtitle || undefined,
      sCodeLang: varyLang || undefined,
      IDFUNCTCON: typeof typeDeContact === "number" ? typeDeContact : undefined,

      // Blocked flags
      bBlocked: isBlocked ? 1 : 0,

      // Consents
    };



    const consents = buildConsentsFromHubSpot({ optOutIds: hsDesabonnements, optInIds: hsConsentOptIn });
    if (consents) contactData.Consents = consents; // ← seulement si défini

    if (linksCustomers.length > 0) contactData["LinksCustomers"] = linksCustomers;

    // ---- Auth + call Vary ----
    const token = await getVaryAuthToken(VARY_USER, VARY_PASSWORD);


    //const token = "TQBAAGsArCBUAGgAMwBHAHIANABkAEUAfAA3ADIANwA1ADQANAA1ADcAfAAyADAAMgA1ADAANAAwADgAMAA5ADQANQAyADUAOQA5ADgA";

    console.log("Le token est " + token);
    const result = mode === "create"
      ? await createVaryContact(contactData, token)
      : await updateVaryContact(contactData, vary_id!, token);

    const returnedVaryId = result?.idContact || vary_id;

    if (hubspot_id && returnedVaryId) {
      try {
        await saveVaryIdToHubspot(hubspot_id, returnedVaryId.toString());
      } catch (e) {
        console.error("Impossible de sauvegarder id_contact dans HubSpot:", e);
      }
    }

    return res.status(mode === "create" ? 201 : 200).json({
      message: mode === "create" ? "Contact créé avec succès" : "Contact modifié avec succès",
      vary_contact: result,
      sent_payload: contactData,
      cloud_function_egress_ip: await egressIpPromise,
    });
  } catch (error: any) {
    console.error("Erreur Upsert Contact:", error?.response?.data || error?.message || error);
    return res.status(500).json({
      message: "Erreur lors du traitement du contact",
      details: safeError(error),
      cloud_function_egress_ip: await egressIpPromise,
    });
  }
});


async function saveVaryIdToHubspot(contactId: string, varyId: string): Promise<void> {
  if (!contactId || !varyId) return;

  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;
  const body = {
    properties: {
      id_contact: varyId,
    },
  };

  console.log(url);

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.error(`Erreur sauvegarde id_contact HubSpot: ${resp.status} ${await resp.text()}`);
  } else {
    console.log(`id_contact sauvegardé dans HubSpot pour contact ${contactId}`);
  }
}
