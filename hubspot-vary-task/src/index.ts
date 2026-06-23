import * as functions from "@google-cloud/functions-framework";
import axios from "axios";
import type { Request, Response } from "@google-cloud/functions-framework";

/** =============================
 * Environnement (TEST)
 * ============================== */
const VARY_API_URL = process.env.VARY_API_URL || "https://varyws05.enygea.com/test/1/auth/token";
const VARY_TASK_URL = process.env.VARY_TASK_URL || "https://varyws05.enygea.com/test/1/task";
const VARY_TASK_ASSOCIATE_URL = process.env.VARY_TASK_ASSOCIATE_URL || "https://varyws05.enygea.com/test/1/task/link";
const VARY_COMPANY_URL = process.env.VARY_COMPANY_URL || "https://varyws05.enygea.com/test/1/company";   // Société Vary (agence) lookup
const VARY_CUSTOMER_URL = process.env.VARY_CUSTOMER_URL || "https://varyws05.enygea.com/test/1/customer"; // Client lookup (par code)
const VARY_CONTACT_URL = process.env.VARY_CONTACT_URL || "https://varyws05.enygea.com/test/1/contact";

const VARY_USER = process.env.VARY_USER || "";
const VARY_PASSWORD = process.env.VARY_PASSWORD || "";
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || "";

/** =============================
 * Types d'association Vary (swagger)
 * ============================== */
const IDTYPE_VARY_COMPANY = 11; // Société Vary (région/agence interne)
const IDTYPE_CUSTOMER     = 3;  // Client
const IDTYPE_CONTACT      = 23; // Contact

/** =============================
 * Utils
 * ============================== */
const safeError = (err: any) => {
  try { return { message: err?.message ?? "unknown", status: err?.response?.status, data: err?.response?.data }; }
  catch { return { message: "unknown" }; }
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
  if (resp.status < 200 || resp.status >= 300) throw new Error(`Erreur fetch HubSpot company: ${resp.status} ${JSON.stringify(resp.data)}`);
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

async function listAssocContactIdsForCompany(companyId: string|number): Promise<string[]> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const base = `https://api.hubapi.com/crm/v4/objects/companies/${encodeURIComponent(String(companyId))}/associations/contacts?limit=100`;
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const url = after ? `${base}&after=${after}` : base;
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` }, validateStatus: () => true });
    if (r.status < 200 || r.status >= 300) throw new Error(`Assoc v4 contacts error: ${r.status} ${JSON.stringify(r.data)}`);
    for (const x of (r.data?.results ?? [])) {
      const id = String(x?.toObjectId ?? x?.toObject?.id ?? "");
      if (id) ids.push(id);
    }
    after = r.data?.paging?.next?.after;
  } while (after);
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
    if (resp.status < 200 || resp.status >= 300) throw new Error(`Batch/read contacts error: ${resp.status} ${JSON.stringify(resp.data)}`);
    out.push(...(resp.data?.results ?? []));
  }
  return out.map((r: any) => ({ id: String(r.id), properties: r.properties || {} }));
}

/** =============================
 * Notes HubSpot (fallback robuste)
 * ============================== */
async function fetchLatestCompanyNoteViaEngagements(companyId: string | number): Promise<{ body?: string; timestamp?: number } | null> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  let hasMore = true;
  let offset: number | undefined = undefined;
  let latest: { body?: string; timestamp?: number } | null = null;
  while (hasMore) {
    const url = new URL(`https://api.hubapi.com/engagements/v1/engagements/associations/COMPANY/${encodeURIComponent(String(companyId))}/paged`);
    url.searchParams.set("limit", "250");
    if (typeof offset === "number") url.searchParams.set("offset", String(offset));
    const r = await axios.get(url.toString(), {
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` },
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) return null; // fallback prendra la main
    const results = Array.isArray(r.data?.results) ? r.data.results : [];
    for (const e of results) {
      if (e?.engagement?.type !== "NOTE") continue;
      if (e?.engagement?.active === false) continue;
      const ts = Number(e?.engagement?.timestamp ?? e?.engagement?.createdAt ?? 0);
      const rawBody = (e?.metadata?.body ?? "").toString();
      if (!rawBody.trim()) continue;
      if (!latest || ts > (latest.timestamp ?? 0)) latest = { body: rawBody, timestamp: ts };
    }
    hasMore = Boolean(r.data?.hasMore);
    offset  = r.data?.offset;
  }
  return latest;
}

async function listCompanyNoteIdsV4(companyId: string | number): Promise<string[]> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const base = `https://api.hubapi.com/crm/v4/objects/companies/${encodeURIComponent(String(companyId))}/associations/notes?limit=100`;
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const url = after ? `${base}&after=${after}` : base;
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}` }, validateStatus: () => true });
    if (r.status < 200 || r.status >= 300) throw new Error(`Assoc v4 notes error: ${r.status} ${JSON.stringify(r.data)}`);
    for (const x of (r.data?.results ?? [])) {
      const id = String(x?.toObjectId ?? x?.toObject?.id ?? "");
      if (id) ids.push(id);
    }
    after = r.data?.paging?.next?.after;
  } while (after);
  return ids;
}

async function batchReadNotesV3(noteIds: string[]): Promise<Array<{ id: string, hs_note_body?: string, hs_timestamp?: number }>> {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  if (noteIds.length === 0) return [];
  const url = `https://api.hubapi.com/crm/v3/objects/notes/batch/read`;
  const out: Array<{ id: string, hs_note_body?: string, hs_timestamp?: number }> = [];
  for (let i = 0; i < noteIds.length; i += 100) {
    const chunk = noteIds.slice(i, i + 100);
    const r = await axios.post(url, {
      properties: ["hs_note_body", "hs_timestamp"],
      inputs: chunk.map(id => ({ id })),
    }, {
      headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`Notes batch/read error: ${r.status} ${JSON.stringify(r.data)}`);
    for (const it of (r.data?.results ?? [])) {
      const p = it?.properties ?? {};
      out.push({
        id: String(it.id),
        hs_note_body: p.hs_note_body ?? undefined,
        hs_timestamp: p.hs_timestamp ? Number(p.hs_timestamp) : undefined,
      });
    }
  }
  return out;
}

async function fetchLatestCompanyNoteSafe(companyId: string | number): Promise<{ body?: string; timestamp?: number } | null> {
  try {
    const n = await fetchLatestCompanyNoteViaEngagements(companyId);
    if (n?.body) return n;
  } catch (e) {
    console.warn("Engagements v1 failed:", safeError(e));
  }
  const ids = await listCompanyNoteIdsV4(companyId);
  if (!ids.length) return null;
  const notes = await batchReadNotesV3(ids);
  notes.sort((a,b) => (b.hs_timestamp ?? 0) - (a.hs_timestamp ?? 0));
  const top = notes.find(n => (n.hs_note_body ?? "").trim());
  return top ? { body: top.hs_note_body, timestamp: top.hs_timestamp } : null;
}

/** =============================
 * Vary API helpers
 * ============================== */
async function getVaryAuthToken(user: string, password: string): Promise<string> {
  const response = await axios.post(VARY_API_URL, { user, password, type: "" }, { headers: { "Content-Type": "application/json" } });
  if (response.status !== 200 || !response.data?.Token) throw new Error("Token Vary non reçu");
  return response.data.Token as string;
}

// Société Vary (agence) par pays/CP
async function getVaryCompany(token: string, country: string, code_postal: string): Promise<any> {
  const url = `${VARY_COMPANY_URL}?sCountryCode=${encodeURIComponent(country)}&sPostCode=${encodeURIComponent(code_postal)}&nTypeDoss=1`;
  const response = await axios.get(url, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
  });
  if (response.status !== 200) throw new Error(`Erreur HTTP lors de la récupération de la Société Vary: ${response.status}`);
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
  const id = Number(String(cust?.idCustomer ?? cust?.id ?? cust?.nIdCustomer ?? "").trim());
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

async function createVaryTask(taskData: object, token: string): Promise<any> {
  const response = await axios.post(VARY_TASK_URL, taskData, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (![200, 201].includes(response.status)) {
    throw new Error(`Erreur HTTP création tâche: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

// Association via /task/link (tabIdKeys)
async function linkTask(taskId: number, idType: number, ids: number[], token: string) {
  if (!ids.length) return null;
  const r = await axios.post(
    VARY_TASK_ASSOCIATE_URL,
    { idTask: taskId, idType, tabIdKeys: ids },
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, validateStatus: () => true }
  );
  if (r.status !== 200) throw new Error(`link failed (idType=${idType}): ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

// Création contact Vary si manquant
async function createVaryContact(token: string, payload: {
  idCompany: number,
  sFirstName?: string,
  sLastName?: string,
  sEmail?: string,
  sPhone?: string
}): Promise<{ idContact: number }> {
  const resp = await axios.post(VARY_CONTACT_URL, payload, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`Erreur HTTP création contact Vary: ${resp.status} ${JSON.stringify(resp.data)}`);
  }
  const id =
    toNum(resp.data?.idContact) ??
    toNum(resp.data?.nIdContact) ??
    toNum(resp.data?.contactId);
  if (!id) throw new Error(`Réponse création contact Vary sans id exploitable: ${JSON.stringify(resp.data)}`);
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
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    await handler(req, res);
  };
}

/** =========================================================
 * HTTP — Create Task from latest Company Note + link Société Vary + Client + Contacts
 * ========================================================= */
functions.http(
  "hubspotVaryCustomers",
  withCORS(async (req: Request, res: Response) => {
    try {
      const raw = (req.body ?? {}) as any;
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;

      // 1) Company HS ID (priorité objectId)
      const idCompanyHS =
        (payload?.objectId ?? payload?.properties?.objectId ??
         payload?.hs_object_id ?? payload?.properties?.hs_object_id)?.toString().trim();
      if (!idCompanyHS) {
        return res.status(400).json({
          message: "objectId (Company) manquant dans le payload.",
          debug_hint: { top_level_keys: Object.keys(payload || {}) },
        });
      }

      // 2) Auth Vary
      const token = await getVaryAuthToken(VARY_USER, VARY_PASSWORD);

      // 3) Lire Company HubSpot (props nécessaires)
      const wantedProps = [
        // pour Société Vary lookup
        "country","address_country","zip","postal_code","hs_postal_code","adresse_code_postal","pays",
        // pour Client (customer) lookup
        "idclient_vary","id_vary","code_client_vary"
      ];
      const hsCompany = await fetchHubSpotCompany(idCompanyHS, wantedProps);
      const hsProps   = hsCompany?.properties ?? {};

      // 4) Résoudre la Société Vary (agence) par pays/CP
      const country = (hsProps.country ?? hsProps.address_country ?? hsProps.pays ?? "FR").toString().trim() || "FR";
      const postCode = (hsProps.zip ?? hsProps.postal_code ?? hsProps.hs_postal_code ?? hsProps.adresse_code_postal ?? "").toString().trim();
      const varyCompanies = await getVaryCompany(token, country, postCode || "");
      const compList = Array.isArray(varyCompanies?.Companies) ? varyCompanies.Companies : [];
      if (!compList.length) {
        return res.status(404).json({
          message: "Aucune Société Vary trouvée pour les critères (pays/CP).",
          debug_hint: { hubspot_company_id: idCompanyHS, country, postCode: postCode || null },
        });
      }
      const varyCompany = compList[0];
      const idVaryCompany = toNum(varyCompany?.idCompany ?? varyCompany?.id ?? varyCompany?.nIdCompany);
      if (!idVaryCompany) {
        return res.status(502).json({ message: "Société Vary trouvée mais id illisible", varyCompany });
      }

      // 5) Résoudre l'id du Client (customer) à partir de HS: idclient_vary (num) ou code_client_vary -> lookup
      let idVaryCustomer = toNum(
        hsProps.idclient_vary ??
        hsProps.idclient_vary?.value ??
        hsProps.id_vary ??
        hsProps.id_vary?.value
      );
      if (!idVaryCustomer) {
        const code = (hsProps.code_client_vary ?? hsProps.code_client_vary?.value ?? "").toString().trim();
        if (code) idVaryCustomer = await getVaryCustomerIdByCode(token, code);
      }
      if (!idVaryCustomer) {
        return res.status(404).json({
          message: "Client Vary introuvable: renseigner 'idclient_vary' (numérique) ou 'code_client_vary' sur la Company HubSpot.",
          debug_hint: { hubspot_company_id: idCompanyHS }
        });
      }

      // 6) Dernière note + nettoyage HTML
      const lastNote = await fetchLatestCompanyNoteSafe(idCompanyHS);
      const sNoteClean = stripHtmlAndEntities(lastNote?.body || "");

      // 7) Contacts associés (dédup + backfill id_contact si manquant)
      const contactIds = await listAssocContactIdsForCompany(idCompanyHS);
      const contacts = await batchReadHubSpotContacts(
        contactIds,
        ["id_contact", "firstname", "lastname", "email", "phone", "mobilephone"]
      );

      const contactIdSet = new Set<number>();
      const alreadyKnown: number[] = [];
      const createdNow: number[] = [];

      for (const c of contacts) {
        const p = c.properties || {};
        let idContactVary = Number(p.id_contact);

        if (!Number.isFinite(idContactVary) || idContactVary <= 0) {
          const first = (p.firstname || "").toString().trim();
          const last  = (p.lastname  || "").toString().trim();
          const email = (p.email     || "").toString().trim();
          const phone = (p.mobilephone || p.phone || "").toString().trim();

          const created = await createVaryContact(token, {
            idCompany: idVaryCompany!,
            sFirstName: first || undefined,
            sLastName:  last  || undefined,
            sEmail:     email || undefined,
            sPhone:     phone || undefined,
          });
          idContactVary = created.idContact;

          try {
            await updateHubSpotObject("contacts", c.id, { id_contact: idContactVary });
          } catch (e) {
            console.warn("Maj contact HS id_contact échouée (non bloquant):", safeError(e));
          }

          createdNow.push(idContactVary);
        } else {
          alreadyKnown.push(idContactVary);
        }

        if (idContactVary) contactIdSet.add(idContactVary);
      }

      const varyContactIds = Array.from(contactIdSet);

      // 8) Choisir le contact principal (priorité à un déjà connu)
      const primaryContactId =
        alreadyKnown.find(Boolean) ??
        varyContactIds[0] ??
        undefined;

      // 9) Création de la tâche : uniquement le principal dans idContact
      const t = readTaskFromPayload(payload);
      const taskData: any = {
        idAction:   t.idAction ?? 7,
        idCompany:  idVaryCompany,                 // Société Vary (agence interne)
        idContact:  primaryContactId || undefined, // UNIQUEMENT le principal
        sNote:      sNoteClean,
        idExternal: t.idExternal ?? idCompanyHS,   // trace HS
      };

      const taskCreated = await createVaryTask(taskData, token);

      // 10) Lier Société Vary (11) + Client (3)
      let assocVaryCompany: any = null;
      let assocCustomer: any = null;

      try {
        // Si ta plateforme Vary ajoute déjà l'agence via idCompany, commente ce bloc.
        assocVaryCompany = await linkTask(
          taskCreated.idTask,
          IDTYPE_VARY_COMPANY,   // 11
          [idVaryCompany!],
          token
        );
      } catch (e) {
        console.warn("Vary company link warn:", safeError(e));
      }

      try {
        assocCustomer = await linkTask(
          taskCreated.idTask,
          IDTYPE_CUSTOMER,       // 3
          [idVaryCustomer!],
          token
        );
      } catch (e) {
        console.warn("Customer link warn:", safeError(e));
      }

      // 11) Link des contacts secondaires (évite le doublon avec le principal)
      const secondaryContactIds = varyContactIds.filter(id => id !== primaryContactId);
      let assocContacts: any = null;
      if (secondaryContactIds.length) {
        try {
          assocContacts = await linkTask(taskCreated.idTask, IDTYPE_CONTACT, secondaryContactIds, token);
        } catch (e) {
          console.warn("Contacts link warn:", safeError(e));
        }
      }

      // 12) MAJ HubSpot Company: id_task_vary
      let hubspotUpdate: any = null;
      let hubspotUpdateError: any = null;
      try {
        hubspotUpdate = await updateHubSpotObject("companies", idCompanyHS, { id_task_vary: taskCreated?.idTask });
      } catch (e: any) {
        hubspotUpdateError = safeError(e);
      }

      // 13) Réponse
      return res.status(201).json({
        message: "Tâche Vary créée depuis la dernière note Company, liée à la Société Vary, au Client et aux Contacts",
        vary_task: taskCreated,
        sent_payload: taskData,
        associations: { vary_company: assocVaryCompany, customer: assocCustomer, contacts: assocContacts },
        stats: { contacts_total: contacts.length, contacts_linked: varyContactIds.length },
        hubspot_update: hubspotUpdate,
        hubspot_update_error: hubspotUpdateError,
        debug: { idCompanyHS, idVaryCompany, idVaryCustomer, primaryContactId, varyContactIds, createdNow, alreadyKnown },
      });
    } catch (error: any) {
      console.error("Erreur hubspotVaryTask:", safeError(error));
      return res.status(500).json({ message: "Erreur lors du traitement de la tâche", details: safeError(error) });
    }
  })
);
