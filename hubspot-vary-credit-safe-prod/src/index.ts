// hubspotVaryCreditSafeProd.ts
import * as functions from "@google-cloud/functions-framework";
import axios from "axios";
import type { Request, Response } from "@google-cloud/functions-framework";

/** ===== ENV ===== */
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY || "";

const CS_BASE_URL = process.env.CREDITSAFE_BASE_URL || "https://connect.sandbox.creditsafe.com";
const CS_USERNAME = process.env.CREDITSAFE_USERNAME || "";
const CS_PASSWORD = process.env.CREDITSAFE_PASSWORD || "";
const CS_COUNTRY_DEFAULT = (process.env.CREDITSAFE_COUNTRY_DEFAULT || "FR").toUpperCase();
const CS_TIMEOUT_MS = Number(process.env.CREDITSAFE_TIMEOUT_MS || "300000");
const CS_SEARCH_PAGE = Number(process.env.CREDITSAFE_SEARCH_PAGE || "1");
const CS_SEARCH_PAGESIZE = Number(process.env.CREDITSAFE_SEARCH_PAGESIZE || "1");
const CS_REPORT_LANGUAGE = process.env.CREDITSAFE_REPORT_LANGUAGE || "fr";
const CS_REPORT_TEMPLATE = process.env.CREDITSAFE_REPORT_TEMPLATE || "full";
const CS_REPORT_INCLUDE_INDICATORS = ["true","1","yes","on"].includes((process.env.CREDITSAFE_REPORT_INCLUDE_INDICATORS || "false").toLowerCase());
const CS_REPORT_CUSTOM_DATA = process.env.CREDITSAFE_REPORT_CUSTOM_DATA || "string";

/** ===== Utils ===== */
const isTruthy = (v: any) => [true,"true",1,"1","yes","on"].includes((v ?? "").toString().toLowerCase());
const safeError = (err: any) => { try { return { message: err?.message ?? "unknown", status: err?.response?.status, data: err?.response?.data }; } catch { return { message: "unknown" }; } };
const nonEmpty = (v: any) => v !== undefined && v !== null && String(v).trim() !== "";

function toNumberSafe(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[^\d,.\-]/g, "").replace(/,/g, ".");
    const n = Number(s);
    return isFinite(n) ? n : undefined;
  }
}

function pick<T=any>(obj: any, ...paths: (string | string[])[]): T | undefined {
  for (const p of paths) {
    const parts = Array.isArray(p) ? p : p.split(".");
    let cur = obj; let ok = true;
    for (const k of parts) { if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k]; else { ok = false; break; } }
    if (ok && cur != null) return cur as T;
  }
  return undefined;
}

// Normalisation des payloads HubSpot (webhooks/workflows)
function normalizeHubSpotBody(req: Request) {
  const raw = (req.body && typeof req.body === "object") ? req.body : {};
  const props = (raw.properties && typeof raw.properties === "object")
    ? raw.properties
    : (raw.inputFields && typeof raw.inputFields === "object")
    ? raw.inputFields
    : raw;

  const getProp = (key: string): any => {
    const node = (props && typeof props === "object") ? props[key] : undefined;
    return (
      node?.value ?? node ?? raw?.[key]?.value ?? raw?.[key] ?? raw?.properties?.[key]?.value ?? undefined
    );
  };

  return { raw, props, getProp };
}

/** ===== Creditsafe ===== */
async function csAuthenticate(): Promise<string> {
  if (!CS_USERNAME || !CS_PASSWORD) throw new Error("CREDITSAFE credentials manquants");
  const { data, status } = await axios.post(
    `${CS_BASE_URL}/v1/authenticate`,
    { username: CS_USERNAME, password: CS_PASSWORD },
    { timeout: CS_TIMEOUT_MS, headers: { "Content-Type": "application/json" } }
  );
  const token = data?.token || data?.access_token;
  if (status !== 200 || !token) throw new Error(`Authenticate Creditsafe: token manquant (status ${status})`);
  return String(token);
}

type CsCompany = { id: string };
async function csSearchCompany(token: string, params: { countries?: string; registrationNumber?: string; name?: string; vatNumber?: string; page?: number; pageSize?: number; }): Promise<CsCompany | null> {
  const query: Record<string, any> = {
    countries: (params.countries || CS_COUNTRY_DEFAULT).toUpperCase(),
    page: params.page ?? CS_SEARCH_PAGE,
    pageSize: params.pageSize ?? CS_SEARCH_PAGESIZE,
  };
  if (params.registrationNumber) query.regNo = params.registrationNumber;
  if (params.vatNumber) query.vatNo = params.vatNumber;
  if (params.name) query.name = params.name;

  const { data, status } = await axios.get(`${CS_BASE_URL}/v1/companies`, {
    headers: { Authorization: `Bearer ${token}` },
    params: query,
    timeout: CS_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (status !== 200 || !Array.isArray(data?.companies) || data.companies.length === 0) return null;
  return { id: String(data.companies[0].id) };
}

async function csGetCreditReport(token: string, id: string): Promise<any | null> {
  const { data, status } = await axios.get(`${CS_BASE_URL}/v1/companies/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params: { language: CS_REPORT_LANGUAGE, template: CS_REPORT_TEMPLATE, includeIndicators: CS_REPORT_INCLUDE_INDICATORS, customData: CS_REPORT_CUSTOM_DATA },
    validateStatus: () => true,
    timeout: CS_TIMEOUT_MS,
  });
  if (status !== 200 || !data) return null;
  return data?.report ?? data ?? null;
}

function mapCreditsafeMetrics(report: any): { score?: number; rating?: string; ratingText?: string; limit?: number; } {
  const cur = report?.creditScore?.currentCreditRating;
  const sum = report?.companySummary?.creditRating;
  const scoreRaw = cur?.providerValue?.value ?? sum?.providerValue?.value ?? cur?.providerValue ?? sum?.providerValue ?? cur?.value ?? sum?.value;
  const limitRaw = report?.creditScore?.currentCreditRating?.creditLimit?.value
                ?? report?.companySummary?.creditRating?.creditLimit?.value
                ?? report?.recommendedCreditLimit?.value
                ?? report?.companySummary?.recommendedCreditLimit?.value
                ?? report?.creditLimit?.value;
  const rating = cur?.commonValue ?? sum?.commonValue ?? cur?.rating ?? sum?.rating ?? cur?.code ?? sum?.code;
  const ratingText = cur?.commonDescription ?? sum?.commonDescription ?? cur?.description ?? sum?.description;
  return { score: toNumberSafe(scoreRaw), rating: rating ? String(rating) : undefined, ratingText: ratingText ? String(ratingText) : undefined, limit: toNumberSafe(limitRaw) };
}

/** ===== HubSpot PATCH helper ===== */
async function patchHubSpotCompany(companyId: string, props: Record<string, any>) {
  if (!HUBSPOT_API_KEY) throw new Error("HUBSPOT_API_KEY manquant");
  const url = `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(companyId)}`;
  const { data, status } = await axios.patch(url, { properties: props }, {
    headers: { Authorization: `Bearer ${HUBSPOT_API_KEY}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
  if (status < 200 || status >= 300) throw new Error(`Erreur update HubSpot company: ${status} ${JSON.stringify(data)}`);
  return data;
}

/** ===== Function: enrich + update HubSpot =====
 * Body attendu (souple):
 * {
 *   // SIRET obligatoire (14 chiffres) — pris dans properties|inputFields|racine
 *   "siret": "83105386300039",
 *   // optionnels
 *   "country": "FR",
 *   "companyId": "259937274069",  // id HubSpot à mettre à jour
 *   "updateHubSpot": true,        // default true
 *   "overwrite": false,           // default false (merge sans écraser les champs non vides)
 *   "includeReport": false        // si true => renvoie le rapport brut
 * }
 */
functions.http("hubspotVaryCreditSafeProd", async (req: Request, res: Response) => {
  try {
    // CORS
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).send("");
    }
    res.set("Access-Control-Allow-Origin", "*");

    // Normalisation HubSpot
    const { raw, props, getProp } = normalizeHubSpotBody(req);

    // Lecture paramètres
    const siret = String(getProp("siret") ?? "").trim();
    const country = String(getProp("pays__iso_") ?? getProp("country") ?? CS_COUNTRY_DEFAULT).toUpperCase();
    const companyId = String(getProp("hs_object_id") ?? getProp("companyId") ?? "").trim();
    const includeReport = isTruthy(getProp("includeReport"));
    const updateHubSpot = getProp("updateHubSpot") === undefined ? true : isTruthy(getProp("updateHubSpot"));
    const overwrite = true;

    // Validation SIRET
    if (!/^\d{14}$/.test(siret)) {
      return res.status(400).json({ message: "Paramètre 'siret' requis (14 chiffres)", got: siret });
    }

    // Appels Creditsafe
    const token = await csAuthenticate();
    const company = await csSearchCompany(token, { countries: country, registrationNumber: siret });
    if (!company?.id) return res.status(404).json({ message: "Société introuvable dans Creditsafe pour ce SIRET", siret, country });

    const report = await csGetCreditReport(token, company.id);
    if (!report) return res.status(404).json({ message: "Rapport Creditsafe introuvable", companyId: company.id });

    // Mapping + enrichissements demandés
    const metrics = mapCreditsafeMetrics(report);
    const { line1, line2, zip, city, countryCode } = extractAddressFromReportV2(report, country);
    // TVA (priorité aux chemins présents dans ton payload)
    let vat =
      pick<string>(
        report,
        "companyIdentification.basicInformation.vatRegistrationNumber", // ✅ vu dans ton log
        "companyIdentification.vatNumber",
        "companyIdentification.vat.vatNumber",
        "companySummary.vatNumber"
      );

    // Fallback FR: dériver à partir du SIRET si manquant
    if (!vat && country === "FR" && /^\d{14}$/.test(siret)) {
      const siren = Number(siret.slice(0, 9));
      const key = (12 + 3 * siren) % 97;
      vat = `FR${String(key).padStart(2, "0")}${siren}`;
    }


    console.log("CS address", { line1, line2, zip, city, countryCode, vat });



    const enrichment = {
      siret,
      csCompanyId: company.id,
      score: metrics.score,
      rating: metrics.rating,
      ratingText: metrics.ratingText,
      limit: metrics.limit,
      address: { line1: line1 || undefined, line2: line2 || undefined, zip: zip || undefined, city: city || undefined, countryCode: countryCode || undefined },
      vatNumber: vat || undefined,
      ...(includeReport ? { report } : {}),
    };

    // Préparation update HubSpot
    let hubspotUpdate: any = null;
    let hubspotUpdateError: any = null;

    if (updateHubSpot && nonEmpty(companyId)) {
      // Lecture des valeurs existantes si on est en mode merge (pour ne pas écraser ce qui est déjà rempli)
      // NB: si tu veux être 100% strict sur "merge", tu peux GET la company avant; ici on se contente d'un merge "simple" basé sur valeurs entrantes.
      const patch: Record<string, any> = {};

      // Propriétés "scores" (toujours posées si présentes)
      if (typeof enrichment.limit === "number") patch.credit_safe_limit_score = enrichment.limit;
      if (typeof enrichment.score === "number") patch.credit_safe_score = enrichment.score;
      if (enrichment.ratingText) patch.rating_text = enrichment.ratingText;

      // Adresse / TVA : merge vs overwrite
      const maybeSet = (key: string, value?: any) => {
        if (!nonEmpty(value)) return;
        if (overwrite) { patch[key] = value; return; }
        // merge: on ne set que si le caller n'a rien donné pour ce champ (=> on prend l'enrichissement si le champ est vide côté appelant)
        // Si tu veux vérifier la valeur EXISTANTE dans HubSpot, fais un GET préalable (non inclus ici pour rester simple).
        const callerValue = getProp(key);
        if (!nonEmpty(callerValue)) patch[key] = value;
      };

      maybeSet("address", enrichment.address.line1);
      maybeSet("address2", enrichment.address.line2);
      maybeSet("zip", enrichment.address.zip);
      maybeSet("city", enrichment.address.city);
      maybeSet("pays__iso_", enrichment.address.countryCode);
      maybeSet("code_tva", enrichment.vatNumber);

      try {
        if (Object.keys(patch).length > 0) {
          hubspotUpdate = await patchHubSpotCompany(companyId, patch);
        }
      } catch (e: any) {
        hubspotUpdateError = safeError(e);
      }
    }

    return res.status(200).json({
      message: "Creditsafe enrich OK",
      companyId: nonEmpty(companyId) ? companyId : null,
      updateHubSpot: !!updateHubSpot,
      overwrite: !!overwrite,
      enrichment,
      hubspot_update: hubspotUpdate,
      hubspot_update_error: hubspotUpdateError
    });
  } catch (e: any) {
    return res.status(500).json({ message: "Erreur Creditsafe/HubSpot", details: safeError(e) });
  }
});


function parseTradingAddress(raw?: string) {
  if (!raw) return {};
  // Cherche un CP FR 5 chiffres
  const m = raw.match(/\b(\d{5})\b/);
  const zip = m?.[1];
  let line1 = raw, city: string | undefined;

  if (zip) {
    // Couper juste avant le code postal pour la ligne d'adresse
    const [left, right] = raw.split(zip, 2);
    line1 = left?.trim().replace(/[,\s]+$/,"");
    city = right?.trim();
    // Si la ville est trop collée, on nettoie les tirets multiples
    if (city) city = city.replace(/^-+/, "").trim();
  }
  return { line1, zip, city };
}

function extractAddressFromReportV2(report: any, fallbackCountry: string) {
  // 1) Chemins "classiques" (garder en priorité si déjà présents ailleurs)
  let line1 =
    pick<string>(report, "companyIdentification.address.street",
                         "companyIdentification.address.addressLine1",
                         "companySummary.address.street",
                         "companySummary.address.addressLine1");
  let line2 =
    pick<string>(report, "companyIdentification.address.addressLine2",
                         "companySummary.address.addressLine2");
  let zip =
    pick<string>(report, "companyIdentification.address.postCode",
                         "companySummary.address.postCode",
                         "companyIdentification.address.zip",
                         "companySummary.address.zip");
  let city =
    pick<string>(report, "companyIdentification.address.city",
                         "companySummary.address.city",
                         "companyIdentification.address.town",
                         "companySummary.address.town");
  let countryCode =
    pick<string>(report, "companyIdentification.address.country.isoCode",
                         "companySummary.address.country.isoCode") || fallbackCountry;

  // 2) Nouvelle source principale d’après ton payload
  const mType = pick<string>(report, "contactInformation.mainAddress.type");
  const mStreet = pick<string>(report, "contactInformation.mainAddress.street");
  const mZip = pick<string>(report, "contactInformation.mainAddress.postalCode");
  const mCity = pick<string>(report, "contactInformation.mainAddress.city");
  const mCountry = pick<string>(report, "contactInformation.mainAddress.country");
  const mSimple = pick<string>(report, "contactInformation.mainAddress.simpleValue");

  // On remplit ce qui manque avec mainAddress.*
  if (!line1 && (mStreet || mSimple)) line1 = mStreet || mSimple;
  if (!zip && mZip) zip = mZip;
  if (!city && mCity) city = mCity;
  if (!countryCode && mCountry) countryCode = mCountry;

  // 3) Autre source possible si certains reports utilisent establishmentDetails
  const estCity = pick<string>(report, "establishmentDetails.city");
  const estTrading = pick<string>(report, "establishmentDetails.tradingAddress");
  if ((!line1 || !zip || !city) && estTrading) {
    const m = estTrading.match(/\b(\d{5})\b/);
    const parsedZip = m?.[1];
    if (!zip && parsedZip) zip = parsedZip;
    if (!city && estCity) city = estCity;
    if (!line1) {
      // si simpleValue absent, on coupe avant le CP
      if (parsedZip) {
        const [left] = estTrading.split(parsedZip, 2);
        line1 = (left || "").trim().replace(/[,\s]+$/,"");
      } else {
        line1 = estTrading;
      }
    }
  }

  return {
    line1: line1 || undefined,
    line2: line2 || undefined,
    zip: zip || undefined,
    city: city || undefined,
    countryCode: (countryCode || fallbackCountry || "").toString().toUpperCase() || undefined,
  };
}
