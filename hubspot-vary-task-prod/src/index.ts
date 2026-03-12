import * as functions from "@google-cloud/functions-framework";
import axios from "axios";
import type { Request, Response } from "@google-cloud/functions-framework";

/** =============================
 * Axios global timeout
 * ============================== */
axios.defaults.timeout = 10000; // 10s par requête (ajustable)

/** =============================
 * Environnement
 * ============================== */
const VARY_API_URL = process.env.VARY_API_URL || "https://varyws06.enygea.com/prod/1/auth/token";
const VARY_TASK_URL = process.env.VARY_TASK_URL || "https://varyws06.enygea.com/prod/1/task";
const VARY_TASK_ASSOCIATE_URL = process.env.VARY_TASK_ASSOCIATE_URL || "https://varyws06.enygea.com/prod/1/task/link";
const VARY_COMPANY_URL = process.env.VARY_COMPANY_URL || "https://varyws06.enygea.com/prod/1/company";   // Société Vary (agence) lookup
const VARY_CUSTOMER_URL = process.env.VARY_CUSTOMER_URL || "https://varyws06.enygea.com/prod/1/customer"; // Client lookup (par code)
const VARY_CONTACT_URL = process.env.VARY_CONTACT_URL || "https://varyws06.enygea.com/prod/1/contact";

const VARY_USER = process.env.VARY_USER || "";
const VARY_PASSWORD = process.env.VARY_PASSWORD || "";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || "";

/** =============================
 * Types d'association Vary (swagger)
 * ============================== */
const IDTYPE_VARY_COMPANY = 11; // Société Vary (région/agence interne)
const IDTYPE_CUSTOMER = 3;  // Client
const IDTYPE_CONTACT = 23; // Contact

/** =============================
 * Utils
 * ============================== */
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

function getAtPath(obj: any, path: (string | number)[]): any {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key as any];
  }
  return cur;
}

function resolveString(payload: any, aliases: (string | (string | number)[])[]): string | undefined {
  for (const alias of aliases) {
    const path = Array.isArray(alias) ? alias : alias.includes(".") ? alias.split(".") : [alias];
    let v = getAtPath(payload, path);
    if (v && typeof v === "object" && "value" in v && (v as any).value != null) v = (v as any).value;
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

function stripHtmlAndEntities(s: string): string {
  if (!s) return "";
  const noTags = s
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
  const unescaped = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  return unescaped.replace(/\s+/g, " ").trim();
}

function toNum(v: any): number | undefined {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const readTaskFromPayload = (payload: any) => {
  const t = payload?.task || {};
  const pick = (k: string) => t[k] ?? payload[`task_${k}`];
  return {
    sNote: (pick("note_devis") ?? pick("note") ?? pick("comment") ?? pick("message") ?? "").toString(),
    idAction: 7,
    idExternal: pick("hs_object_id") ?? pick("external_id") ?? pick("deal_id") ?? undefined,
  };
};

/** =============================
 * Normalisation pays -> ISO2
 * ============================== */
function normalizeCountryToISO2(raw: any): string {
  const fallback = "FR";
  if (raw == null) return fallback;

  const s = String(raw).trim();
  if (!s) return fallback;

  const upper = s.toUpperCase();

  // Si c'est déjà un code ISO2, on renvoie tel quel
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  // On enlève les accents
  const normalized = upper.normalize("NFD").replace(/[\u0300-\u036F]/g, "");

  const map: Record<string, string> = {
    // France
    FR: "FR",
    FRANCE: "FR",
    REPUBLIQUEFRANCAISE: "FR",

    // Luxembourg
    LUXEMBOURG: "LU",
    GRANDDUCHEDELUXEMBOURG: "LU",
    GRANDDUCHEDULUXEMBOURG: "LU",

    // Belgique
    BELGIQUE: "BE",
    BELGIUM: "BE",

    // Suisse
    SUISSE: "CH",
    SWITZERLAND: "CH",

    // Allemagne
    ALLEMAGNE: "DE",
    GERMANY: "DE",

    // Espagne
    ESPAGNE: "ES",
    SPAIN: "ES",

    // Italie
    ITALIE: "IT",
    ITALY: "IT",
  };

  return map[upper] || map[normalized] || fallback;
}

/** =============================
 * HubSpot API
 * ============================== */
async function fetchHubSpotCompany(companyId: string | number, properties?: string[]): Promise<Record<string, any>> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const base = `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(String(companyId))}`;
  const params = properties?.length ? `?properties=${properties.map(encodeURIComponent).join(",")}` : "";
  const url = `${base}${params}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erreur fetch HubSpot company: ${resp.status} ${JSON.stringify(resp.data)}`);
  }
  return resp.data;
}

async function updateHubSpotObject(
  objectType: "companies" | "deals" | "contacts",
  objectId: string | number,
  properties: Record<string, any>
): Promise<any> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${encodeURIComponent(String(objectId))}`;
  const resp = await axios.patch(url, { properties }, {
    headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erreur update HubSpot ${objectType}: ${resp.status} ${JSON.stringify(resp.data)}`);
  }
  return resp.data;
}

async function listAssocContactIdsForCompany(companyId: string | number): Promise<string[]> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const base = `https://api.hubapi.com/crm/v4/objects/companies/${encodeURIComponent(String(companyId))}/associations/contacts?limit=100`;
  const ids: string[] = [];
  let after: string | undefined;
  const MAX_PAGES = 20;
  let pageCount = 0;

  do {
    pageCount++;
    const url = after ? `${base}&after=${after}` : base;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` },
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Assoc v4 contacts error: ${r.status} ${JSON.stringify(r.data)}`);
    }
    for (const x of (r.data?.results ?? [])) {
      const id = String(x?.toObjectId ?? x?.toObject?.id ?? "");
      if (id) ids.push(id);
    }
    const newAfter = r.data?.paging?.next?.after;
    if (newAfter && newAfter === after) {
      console.warn("listAssocContactIdsForCompany: 'after' inchangé, on casse la boucle");
      break;
    }
    after = newAfter;
  } while (after && pageCount < MAX_PAGES);

  return ids;
}

function resolveCompanyIdHS(payload: any): string | undefined {
  const val =
    (payload?.objectId ?? payload?.properties?.objectId ??
      payload?.hs_object_id ?? payload?.properties?.hs_object_id) as any;
  if (val == null) return undefined;
  const s = String(val).trim();
  return s || undefined;
}

async function batchReadHubSpotContacts(ids: string[], properties: string[]) {
  if (!HUBSPOT_API_KEY || ids.length === 0) return [];
  const url = `https://api.hubapi.com/crm/v3/objects/contacts/batch/read`;
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await axios.post(url, { properties, inputs: chunk.map(id => ({ id })) }, {
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
      validateStatus: () => true,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Batch/read contacts error: ${resp.status} ${JSON.stringify(resp.data)}`);
    }
    out.push(...(resp.data?.results ?? []));
  }
  return out.map((r: any) => ({ id: String(r.id), properties: r.properties || {} }));
}

/** =============================
 * Notes HubSpot (CRM v3/v4 only)
 * ============================== */

async function listCompanyNoteIdsV4(companyId: string | number): Promise<string[]> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const base = `https://api.hubapi.com/crm/v4/objects/companies/${encodeURIComponent(String(companyId))}/associations/notes?limit=100`;
  const ids: string[] = [];
  let after: string | undefined;
  const MAX_PAGES = 10;
  let pageCount = 0;

  console.log("NOTES STEP 1 - listCompanyNoteIdsV4 start");

  do {
    pageCount++;
    const url = after ? `${base}&after=${after}` : base;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` },
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Assoc v4 notes error: ${r.status} ${JSON.stringify(r.data)}`);
    }
    for (const x of (r.data?.results ?? [])) {
      const id = String(x?.toObjectId ?? x?.toObject?.id ?? "");
      if (id) ids.push(id);
    }
    const newAfter = r.data?.paging?.next?.after;
    if (newAfter && newAfter === after) {
      console.warn("listCompanyNoteIdsV4: 'after' inchangé, on casse la boucle");
      break;
    }
    after = newAfter;
  } while (after && pageCount < MAX_PAGES);

  console.log("NOTES STEP 1 - listCompanyNoteIdsV4 done, ids:", ids.length);
  return ids;
}

async function batchReadNotesV3(
  noteIds: string[]
): Promise<Array<{
  id: string;
  hs_note_body?: string;
  hs_timestamp?: number;
  hs_createdate?: number;
  hs_lastmodifieddate?: number;
}>> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  if (noteIds.length === 0) return [];

  const url = `https://api.hubapi.com/crm/v3/objects/notes/batch/read`;
  const out: Array<{
    id: string;
    hs_note_body?: string;
    hs_timestamp?: number;
    hs_createdate?: number;
    hs_lastmodifieddate?: number;
  }> = [];

  console.log("NOTES STEP 2 - batchReadNotesV3 start for", noteIds.length, "ids");

  for (let i = 0; i < noteIds.length; i += 100) {
    const chunk = noteIds.slice(i, i + 100);
    const r = await axios.post(
      url,
      {
        properties: [
          "hs_note_body",
          "hs_timestamp",
          "hs_createdate",
          "hs_lastmodifieddate",
        ],
        inputs: chunk.map((id) => ({ id })),
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      }
    );

    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Notes batch/read error: ${r.status} ${JSON.stringify(r.data)}`);
    }

    for (const it of r.data?.results ?? []) {
      const p = it?.properties ?? {};

      const rawTs = p.hs_timestamp ? Number(p.hs_timestamp) : NaN;
      const hs_timestamp = Number.isFinite(rawTs) ? rawTs : undefined;

      const rawCreate = p.hs_createdate ? Date.parse(p.hs_createdate) : NaN;
      const hs_createdate = Number.isFinite(rawCreate) ? rawCreate : undefined;

      const rawLastMod = p.hs_lastmodifieddate ? Date.parse(p.hs_lastmodifieddate) : NaN;
      const hs_lastmodifieddate = Number.isFinite(rawLastMod) ? rawLastMod : undefined;

      out.push({
        id: String(it.id),
        hs_note_body: p.hs_note_body ?? undefined,
        hs_timestamp,
        hs_createdate,
        hs_lastmodifieddate,
      });
    }
  }

  console.log("NOTES STEP 2 - batchReadNotesV3 done, notes:", out.length);
  return out;
}


/**
 * Retourne la dernière note liée à la Company via CRM v3/v4.
 * On ne passe plus par engagements v1 pour éviter les lenteurs / incohérences.
 */
async function fetchLatestCompanyNoteSafe(
  companyId: string | number
): Promise<{ body?: string; timestamp?: number } | null> {
  console.log("NOTES STEP 0 - fetchLatestCompanyNoteSafe for company", companyId);

  let best: { body?: string; timestamp?: number } | null = null;

  try {
    const ids = await listCompanyNoteIdsV4(companyId);
    if (!ids.length) {
      console.log("NOTES STEP 0 - no note ids for company", companyId);
      return null;
    }

    const notes = await batchReadNotesV3(ids);

    for (const n of notes) {
      const body = (n.hs_note_body ?? "").toString();
      if (!body.trim()) continue;

      // on choisit le premier timestamp FINI parmi ceux dispo
      const candidates = [
        n.hs_lastmodifieddate,
        n.hs_timestamp,
        n.hs_createdate,
      ].filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];

      const ts = candidates.length ? candidates[0] : 0;

      if (!best || ts > (best.timestamp ?? 0)) {
        best = { body, timestamp: ts };
      }
    }

    console.log(
      "NOTES STEP 0 - best note:",
      best ? { timestamp: best.timestamp, preview: best.body?.slice(0, 80) } : "none"
    );
  } catch (e) {
    console.warn("fetchLatestCompanyNoteSafe: CRM v3/v4 failed:", safeError(e));
    return null;
  }

  return best;
}


/** =============================
 * Vary API helpers
 * ============================== */
async function getVaryAuthToken(user: string, password: string): Promise<string> {
  const response = await axios.post(
    VARY_API_URL,
    { user, password, type: "" },
    { headers: { "Content-Type": "application/json" } }
  );
  if (response.status !== 200 || !response.data?.Token) throw new Error("Token Vary non reçu");
  return response.data.Token as string;
}

// Société Vary (agence) par pays/CP
async function getVaryCompany(token: string, country: string, code_postal: string): Promise<any> {
  console.log("VARY STEP - getVaryCompany params:", country, code_postal);
  const url = `${VARY_COMPANY_URL}?sCountryCode=${encodeURIComponent(
    country
  )}&sPostCode=${encodeURIComponent(code_postal)}&nTypeDoss=1`;
  const response = await axios.get(url, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    throw new Error(`Erreur HTTP lors de la récupération de la Société Vary: ${response.status}`);
  }
  return response.data;
}

// Client par code client
async function getVaryCustomerIdByCode(token: string, code: string): Promise<number | undefined> {
  if (!code) return undefined;
  const r = await axios.get(VARY_CUSTOMER_URL, {
    headers: { Authorization: `Bearer ${token}` },
    params: { nPageNumber: 1, nPageSize: 1, sCustomerCode: code },
    validateStatus: () => true,
  });
  if (r.status !== 200) return undefined;
  const cust = r.data?.Customers?.[0];
  const id = Number(
    String(cust?.idCustomer ?? cust?.id ?? cust?.nIdCustomer ?? "").trim()
  );
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

async function createVaryTask(taskData: object, token: string): Promise<any> {
  console.log("VARY STEP - createVaryTask payload:", taskData);
  const response = await axios.post(VARY_TASK_URL, taskData, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (![200, 201].includes(response.status)) {
    throw new Error(`Erreur HTTP création tâche: ${response.status} ${JSON.stringify(response.data)}`);
  }
  console.log("VARY STEP - createVaryTask ok, response:", response.data);
  return response.data;
}

// Association via /task/link (tabIdKeys)
async function linkTask(taskId: number, idType: number, ids: number[], token: string) {
  if (!ids.length) return null;
  console.log("VARY STEP - linkTask", { taskId, idType, ids });
  const r = await axios.post(
    VARY_TASK_ASSOCIATE_URL,
    { idTask: taskId, idType, tabIdKeys: ids },
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    }
  );
  if (r.status !== 200) {
    throw new Error(`link failed (idType=${idType}): ${r.status} ${JSON.stringify(r.data)}`);
  }
  console.log("VARY STEP - linkTask ok", { idType, response: r.data });
  return r.data;
}

// Création contact Vary si manquant
async function createVaryContact(
  token: string,
  payload: {
    idCompany: number;
    sFirstName?: string;
    sLastName?: string;
    sEmail?: string;
    sPhone?: string;
  }
): Promise<{ idContact: number }> {
  console.log("VARY STEP - createVaryContact payload:", payload);
  const resp = await axios.post(VARY_CONTACT_URL, payload, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(
      `Erreur HTTP création contact Vary: ${resp.status} ${JSON.stringify(resp.data)}`
    );
  }
  const id =
    toNum(resp.data?.idContact) ??
    toNum(resp.data?.nIdContact) ??
    toNum(resp.data?.contactId);
  if (!id) {
    throw new Error(
      `Réponse création contact Vary sans id exploitable: ${JSON.stringify(resp.data)}`
    );
  }
  console.log("VARY STEP - createVaryContact ok, idContact:", id);
  return { idContact: id };
}

/** =============================
 * CORS
 * ============================== */
function withCORS(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    await handler(req, res);
  };
}

/** =========================================================
 * HTTP — Create Task from latest Company Note + link Société Vary + Client + Contacts
 * ========================================================= */
functions.http(
  "hubspotVaryTaskProd",
  withCORS(async (req: Request, res: Response) => {
    try {
      console.log("STEP 0 - incoming request");

      const raw = (req.body ?? {}) as any;
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;

      console.log("STEP 0 - payload top-level keys:", Object.keys(payload || {}));

      // 1) Company HS ID (priorité objectId)
      const idCompanyHS =
        (payload?.objectId ??
          payload?.properties?.objectId ??
          payload?.hs_object_id ??
          payload?.properties?.hs_object_id)?.toString().trim();
      console.log("STEP 1 - resolved HubSpot company id:", idCompanyHS);

      if (!idCompanyHS) {
        return res.status(400).json({
          message: "objectId (Company) manquant dans le payload.",
          debug_hint: { top_level_keys: Object.keys(payload || {}) },
        });
      }

      // 2) Auth Vary
      console.log("STEP 2 - getVaryAuthToken start");
      const token = await getVaryAuthToken(VARY_USER, VARY_PASSWORD);
      console.log("STEP 2 - getVaryAuthToken done");

      // 3) Lire Company HubSpot (props nécessaires)
      console.log("STEP 3 - fetchHubSpotCompany start");
      const wantedProps = [
        // pour Société Vary lookup
        "country",
        "address_country",
        "zip",
        "postal_code",
        "hs_postal_code",
        "adresse_code_postal",
        "pays",
        // pour Client (customer) lookup
        "id_vary",
        "code_client_vary",
      ];
      const hsCompany = await fetchHubSpotCompany(idCompanyHS, wantedProps);
      const hsProps = hsCompany?.properties ?? {};
      console.log("STEP 3 - fetchHubSpotCompany done, props keys:", Object.keys(hsProps));

      // 4) Résoudre la Société Vary (agence) par pays/CP (country -> ISO2)
      const countryRaw =
        hsProps.country ?? hsProps.address_country ?? hsProps.pays ?? "FR";
      const country = normalizeCountryToISO2(countryRaw);

      const postCode = (
        hsProps.zip ??
        hsProps.postal_code ??
        hsProps.hs_postal_code ??
        hsProps.adresse_code_postal ??
        ""
      )
        .toString()
        .trim();

      console.log("STEP 4 - countryRaw:", countryRaw);
      console.log("STEP 4 - countryIso2:", country);
      console.log("STEP 4 - postCode:", postCode);

      console.log("STEP 4 - getVaryCompany start");
      const varyCompanies = await getVaryCompany(token, country, postCode || "");
      const compList = Array.isArray(varyCompanies?.Companies)
        ? varyCompanies.Companies
        : [];
      console.log("STEP 4 - getVaryCompany done, Companies:", compList.length);

      if (!compList.length) {
        return res.status(404).json({
          message: "Aucune Société Vary trouvée pour les critères (pays/CP).",
          debug_hint: {
            hubspot_company_id: idCompanyHS,
            country,
            postCode: postCode || null,
          },
        });
      }
      const varyCompany = compList[0];
      const idVaryCompany = toNum(
        varyCompany?.idCompany ??
        varyCompany?.id ??
        varyCompany?.nIdCompany
      );
      console.log("STEP 4 - resolved idVaryCompany:", idVaryCompany);

      if (!idVaryCompany) {
        return res
          .status(502)
          .json({ message: "Société Vary trouvée mais id illisible", varyCompany });
      }

      // 5) Résoudre l'id du Client (customer) à partir de HS: id_vary (num) ou code_client_vary -> lookup
      console.log("STEP 5 - resolve Vary customer start");
      let idVaryCustomer = toNum(
        hsProps.id_vary ?? hsProps.id_vary?.value
      );
      if (!idVaryCustomer) {
        const code = (
          hsProps.code_client_vary ??
          hsProps.code_client_vary?.value ??
          ""
        )
          .toString()
          .trim();
        if (code) idVaryCustomer = await getVaryCustomerIdByCode(token, code);
      }
      console.log("STEP 5 - resolved idVaryCustomer:", idVaryCustomer);

      if (!idVaryCustomer) {
        return res.status(404).json({
          message:
            "Client Vary introuvable: renseigner 'id_vary' (numérique) ou 'code_client_vary' sur la Company HubSpot.",
          debug_hint: { hubspot_company_id: idCompanyHS },
        });
      }

      // 6) Dernière note + nettoyage HTML
      console.log("STEP 6 - fetchLatestCompanyNoteSafe start");
      const lastNote = await fetchLatestCompanyNoteSafe(idCompanyHS);
      console.log("STEP 6 - fetchLatestCompanyNoteSafe result:", lastNote);
      const sNoteClean = stripHtmlAndEntities(lastNote?.body || "");
      console.log("STEP 6 - sNoteClean (first 200 chars):", sNoteClean.slice(0, 200));

      // 7) Contacts associés (dédup + backfill id_contact si manquant)
      console.log("STEP 7 - listAssocContactIdsForCompany start");
      const contactIds = await listAssocContactIdsForCompany(idCompanyHS);
      console.log("STEP 7 - listAssocContactIdsForCompany done, ids:", contactIds.length);

      console.log("STEP 7 - batchReadHubSpotContacts start");
      const contacts = await batchReadHubSpotContacts(contactIds, [
        "id_contact",
        "firstname",
        "lastname",
        "email",
        "phone",
        "mobilephone",
      ]);
      console.log("STEP 7 - batchReadHubSpotContacts done, contacts:", contacts.length);

      const contactIdSet = new Set<number>();
      const alreadyKnown: number[] = [];
      const createdNow: number[] = [];

      for (const c of contacts) {
        const p = c.properties || {};
        let idContactVary = Number(p.id_contact);

        if (!Number.isFinite(idContactVary) || idContactVary <= 0) {
          const first = (p.firstname || "").toString().trim();
          const last = (p.lastname || "").toString().trim();
          const email = (p.email || "").toString().trim();
          const phone = (p.mobilephone || p.phone || "").toString().trim();

          const created = await createVaryContact(token, {
            idCompany: idVaryCompany!,
            sFirstName: first || undefined,
            sLastName: last || undefined,
            sEmail: email || undefined,
            sPhone: phone || undefined,
          });
          idContactVary = created.idContact;

          try {
            await updateHubSpotObject("contacts", c.id, {
              id_contact: idContactVary,
            });
          } catch (e) {
            console.warn(
              "STEP 7 - Maj contact HS id_contact échouée (non bloquant):",
              safeError(e)
            );
          }

          createdNow.push(idContactVary);
        } else {
          alreadyKnown.push(idContactVary);
        }

        if (idContactVary) contactIdSet.add(idContactVary);
      }

      const varyContactIds = Array.from(contactIdSet);
      console.log("STEP 7 - varyContactIds:", varyContactIds);
      console.log("STEP 7 - alreadyKnown:", alreadyKnown);
      console.log("STEP 7 - createdNow:", createdNow);

      // 8) Choisir le contact principal (priorité à un déjà connu)
      const primaryContactId =
        alreadyKnown.find(Boolean) ?? varyContactIds[0] ?? undefined;
      console.log("STEP 8 - primaryContactId:", primaryContactId);

      // 9) Création de la tâche : uniquement le principal dans idContact
      const t = readTaskFromPayload(payload);

      const taskData: any = {
        idAction: t.idAction ?? 7,
        idCompany: idVaryCompany, // Société Vary (agence interne)
        idContact: primaryContactId || undefined, // UNIQUEMENT le principal
        sNote: sNoteClean,
        idExternal: t.idExternal ?? idCompanyHS, // trace HS
      };

      console.log("STEP 9 - createVaryTask start");
      const taskCreated = await createVaryTask(taskData, token);
      console.log("STEP 9 - createVaryTask done, idTask:", taskCreated?.idTask);

      // 10) Lier Société Vary (11) + Client (3)
      let assocVaryCompany: any = null;
      let assocCustomer: any = null;

      try {
        assocVaryCompany = await linkTask(
          taskCreated.idTask,
          IDTYPE_VARY_COMPANY, // 11
          [idVaryCompany!],
          token
        );
      } catch (e) {
        console.warn("STEP 10 - Vary company link warn:", safeError(e));
      }

      try {
        assocCustomer = await linkTask(
          taskCreated.idTask,
          IDTYPE_CUSTOMER, // 3
          [idVaryCustomer!],
          token
        );
      } catch (e) {
        console.warn("STEP 10 - Customer link warn:", safeError(e));
      }

      // 11) Link des contacts secondaires (évite le doublon avec le principal)
      const secondaryContactIds = varyContactIds.filter(
        (id) => id !== primaryContactId
      );
      let assocContacts: any = null;
      if (secondaryContactIds.length) {
        try {
          assocContacts = await linkTask(
            taskCreated.idTask,
            IDTYPE_CONTACT,
            secondaryContactIds,
            token
          );
        } catch (e) {
          console.warn("STEP 11 - Contacts link warn:", safeError(e));
        }
      }
      console.log("STEP 11 - assocContacts done");

      // 12) MAJ HubSpot Company: id_task_vary
      let hubspotUpdate: any = null;
      let hubspotUpdateError: any = null;
      try {
        console.log("STEP 12 - updateHubSpotObject company start");
        hubspotUpdate = await updateHubSpotObject("companies", idCompanyHS, {
          id_task_vary: taskCreated?.idTask,
        });
        console.log("STEP 12 - updateHubSpotObject company done");
      } catch (e: any) {
        hubspotUpdateError = safeError(e);
        console.warn("STEP 12 - updateHubSpotObject company error:", hubspotUpdateError);
      }

      // 13) Réponse
      console.log("STEP 13 - sending 201 response");
      return res.status(200).json({
        message:
          "Tâche Vary créée depuis la dernière note Company, liée à la Société Vary, au Client et aux Contacts",
        vary_task: taskCreated,
        sent_payload: taskData,
        associations: {
          vary_company: assocVaryCompany,
          customer: assocCustomer,
          contacts: assocContacts,
        },
        stats: {
          contacts_total: contacts.length,
          contacts_linked: varyContactIds.length,
        },
        hubspot_update: hubspotUpdate,
        hubspot_update_error: hubspotUpdateError,
        debug: {
          idCompanyHS,
          idVaryCompany,
          idVaryCustomer,
          primaryContactId,
          varyContactIds,
          createdNow,
          alreadyKnown,
        },
      });
    } catch (error: any) {
      const se = safeError(error);
      console.error("Erreur hubspotVaryTaskProd:", se);
      return res.status(500).json({
        message: "Erreur lors du traitement de la tâche",
        details: se,
      });
    }
  })
);
