/**
 * scripts/placeholderPeople.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Who the placeholder members are: a deliberately wide spread of names,
 * backgrounds, nationalities, languages, households and Costa Rica
 * situations. The first members of every size walk through each value once
 * (coverage); the rest are drawn with plausible weights. Pure; used by
 * scripts/placeholderData.ts. All names are random first/last pairings
 * (fictional), never real people.
 */

export type Gender = "f" | "m" | "x";

export interface Background {
  key: string;
  label: string;
  firsts: Array<[string, Gender]>;
  lasts: string[];
  nationalities: string[];
  languages: string[];
}

export const BACKGROUNDS: Background[] = [
  { key: "anglo", label: "Anglo", firsts: [["Robert", "m"], ["Linda", "f"], ["Zoë", "f"], ["Graham", "m"], ["Siobhan", "f"], ["Deborah", "f"], ["Russell", "m"], ["Colleen", "f"]], lasts: ["Whitaker", "O'Connor", "Fairbanks-Lowe", "Hollis", "Ashby", "Pendleton", "McAllister", "Winslow"], nationalities: ["US", "UK", "AU", "CA"], languages: ["en"] },
  { key: "hispanic", label: "Hispanic / Latino", firsts: [["José-Luis", "m"], ["María José", "f"], ["Ximena", "f"], ["Guillermo", "m"], ["Inés", "f"], ["Rafael", "m"]], lasts: ["Ibáñez", "Peña", "Ruiz", "Castañeda", "Villaseñor", "Quintero"], nationalities: ["MX", "CO", "AR", "US"], languages: ["es", "en"] },
  { key: "black", label: "Black", firsts: [["Malik", "m"], ["Imani", "f"], ["Thandiwe", "f"], ["Kwame", "m"], ["Deja", "f"], ["Desmond", "m"]], lasts: ["Okafor", "Mthembu", "Washington-Bell", "Adeyemi", "Ellis", "Nkosi"], nationalities: ["US", "ZA", "UK"], languages: ["en"] },
  { key: "east_asian", label: "East Asian", firsts: [["Mei", "f"], ["Hiroshi", "m"], ["Ji-woo", "x"], ["Yuna", "f"], ["Kenji", "m"]], lasts: ["Wu", "Tanaka", "Park", "Lin", "Ōta"], nationalities: ["US", "CA"], languages: ["en"] },
  { key: "south_asian", label: "South Asian", firsts: [["Priya", "f"], ["Arjun", "m"], ["Sanjana", "f"], ["Rohan", "m"]], lasts: ["Raman", "Venkataraman", "Chaudhary", "Iyer"], nationalities: ["IN", "UK", "CA", "US"], languages: ["en"] },
  { key: "se_asian", label: "Southeast Asian", firsts: [["Thảo", "f"], ["Minh", "m"], ["Maricel", "f"], ["Jun", "m"]], lasts: ["Nguyễn", "Trần", "Dela Cruz", "Santos"], nationalities: ["PH", "US"], languages: ["en"] },
  { key: "middle_eastern", label: "Middle Eastern", firsts: [["Layla", "f"], ["Omar", "m"], ["Yasmin", "f"], ["Karim", "m"]], lasts: ["Haddad", "Al-Sayed", "Khoury", "Nasser"], nationalities: ["CA", "US", "UK"], languages: ["fr", "en"] },
  { key: "indigenous", label: "Indigenous North American", firsts: [["Winona", "f"], ["Dakota", "x"], ["Tashina", "f"], ["Ahanu", "m"]], lasts: ["Yazzie", "Begay", "Cardinal", "Thunderchild"], nationalities: ["US", "CA"], languages: ["en"] },
  { key: "eastern_european", label: "Eastern European", firsts: [["Katarzyna", "f"], ["Dmitri", "m"], ["Ivana", "f"], ["Bogdan", "m"]], lasts: ["Kowalczyk", "Petrović", "Novák", "Zieliński"], nationalities: ["DE", "US", "CA"], languages: ["de", "en"] },
  { key: "french_canadian", label: "French-Canadian", firsts: [["Geneviève", "f"], ["Jean-François", "m"], ["Élodie", "f"], ["Marc-André", "m"]], lasts: ["Tremblay", "Gagnon", "Bouchard-Côté", "Lévesque"], nationalities: ["CA"], languages: ["fr", "en"] },
  { key: "jewish", label: "Jewish", firsts: [["Avi", "m"], ["Miriam", "f"], ["Noa", "f"], ["Eli", "m"]], lasts: ["Goldberg", "Rosenthal", "Ben-David", "Kaplan"], nationalities: ["IL", "US"], languages: ["en"] },
  { key: "nordic_germanic", label: "Nordic / Germanic", firsts: [["Åsa", "f"], ["Jürgen", "m"], ["Sanne", "f"], ["Lars", "m"]], lasts: ["Lindqvist", "Müller", "van der Berg", "Østergaard"], nationalities: ["NL", "DE", "US"], languages: ["de", "en"] },
  { key: "french", label: "French", firsts: [["Chloé", "f"], ["Étienne", "m"], ["Margaux", "f"]], lasts: ["Lefèvre", "Dubois", "Moreau-Laurent"], nationalities: ["FR"], languages: ["fr"] },
  { key: "lusophone", label: "Lusophone", firsts: [["João", "m"], ["Luíza", "f"], ["Conceição", "f"]], lasts: ["Gonçalves", "Araújo", "Magalhães"], nationalities: ["US", "CA"], languages: ["pt", "en"] },
  { key: "mixed", label: "Mixed heritage", firsts: [["Kai", "x"], ["Naomi", "f"], ["Mateo", "m"], ["Leilani", "f"]], lasts: ["Okafor-Lindqvist", "Tanaka-Ruiz", "Haddad Brennan", "Nguyễn-Tremblay"], nationalities: ["US", "CA", "AU"], languages: ["en", "es"] },
];

/**
 * The first members of every size, in order: background, nationality (+ second
 * citizenship) and a name shape. Together they cover every background, the
 * listed nationalities, every preferred language and the name edge cases.
 */
export const COVER_PEOPLE: Array<{ bg: string; nat: string; dual?: string; lang?: string; name?: { first: string; last: string; gender: Gender } }> = [
  { bg: "mixed", nat: "US", name: { first: "Kai", last: "Nguyễn-Tremblay", gender: "x" } },
  { bg: "hispanic", nat: "MX", dual: "US", lang: "es", name: { first: "José-Luis", last: "Ibáñez", gender: "m" } },
  { bg: "black", nat: "ZA" },
  { bg: "eastern_european", nat: "DE", lang: "de" },
  { bg: "south_asian", nat: "IN" },
  { bg: "se_asian", nat: "PH", name: { first: "Maricel", last: "Dela Cruz", gender: "f" } },
  { bg: "middle_eastern", nat: "CA", lang: "fr" },
  { bg: "indigenous", nat: "US", name: { first: "Sunniva", last: "", gender: "f" } }, // single-name member
  { bg: "hispanic", nat: "CO", dual: "AR", lang: "es", name: { first: "María del Carmen", last: "Fernández-Castellanos de la Vega", gender: "f" } }, // very long
  { bg: "east_asian", nat: "US", name: { first: "Al", last: "Wu", gender: "m" } }, // very short
  { bg: "french_canadian", nat: "CA", lang: "fr" },
  { bg: "jewish", nat: "IL", dual: "US" },
  { bg: "nordic_germanic", nat: "NL", lang: "de", name: { first: "Åsa", last: "van der Berg", gender: "f" } },
  { bg: "french", nat: "FR", lang: "fr" },
  { bg: "anglo", nat: "UK", dual: "AU", name: { first: "Zoë", last: "O'Connor", gender: "f" } },
  { bg: "lusophone", nat: "US", lang: "pt" },
  { bg: "anglo", nat: "US" },
  { bg: "se_asian", nat: "US", name: { first: "Thảo", last: "Nguyễn", gender: "f" } },
];

export const NATIONALITIES = ["US", "CA", "UK", "DE", "NL", "FR", "IL", "MX", "CO", "AR", "AU", "ZA", "IN", "PH"] as const;
export const LANGUAGES = ["en", "es", "fr", "de", "pt"] as const;
export const PRONOUNS: Record<Gender, string> = { f: "she/her", m: "he/him", x: "they/them" };

export const ACCESSIBILITY = [
  "Prefers large text in documents and emails",
  "Uses a hearing aid; prefers video calls with captions",
  "Prefers a phone call to video",
  "Low vision: send documents as large-print PDF",
  "Prefers short written summaries after each call",
] as const;

export const HOUSEHOLDS = ["single", "married", "same_sex_married", "unmarried_partners", "divorced", "widowed", "blended"] as const;
export type Household = (typeof HOUSEHOLDS)[number];
export const MARITAL: Record<Household, string> = {
  single: "single",
  married: "married",
  same_sex_married: "married",
  unmarried_partners: "partnered",
  divorced: "divorced",
  widowed: "widowed",
  blended: "married",
};
export const PETS = [[], ["dog"], ["2 cats"], ["dog", "cat"], ["rescue dog from the local shelter"], ["parrot"]] as const;

export const RESIDENCIES = [
  "pensionado", "rentista", "inversionista", "digital_nomad", "permanent", "temporary",
  "tourist", "tourist_overstay_risk", "expired", "in_process", "refused",
] as const;
export type Residency = (typeof RESIDENCIES)[number];
export const RESIDENCY_WEIGHTS: Array<[Residency, number]> = [
  ["pensionado", 24], ["rentista", 10], ["inversionista", 8], ["digital_nomad", 12], ["permanent", 10], ["temporary", 6],
  ["tourist", 14], ["tourist_overstay_risk", 3], ["expired", 3], ["in_process", 8], ["refused", 2],
];

export const PROPERTIES = ["none", "condo", "house", "finca", "zmt_concession", "lot", "under_construction", "airbnb_rental", "inherited"] as const;
export type PropertyKind = (typeof PROPERTIES)[number];
export const PROPERTY_WEIGHTS: Array<[PropertyKind, number]> = [
  ["none", 25], ["condo", 15], ["house", 25], ["finca", 6], ["zmt_concession", 5], ["lot", 8], ["under_construction", 5], ["airbnb_rental", 8], ["inherited", 3],
];
export const PROPERTY_LABEL: Record<PropertyKind, string> = {
  none: "No property", condo: "Condo", house: "House", finca: "Farm (finca)", zmt_concession: "Beachfront maritime-zone (ZMT) concession",
  lot: "Building lot", under_construction: "House under construction", airbnb_rental: "Villa rented on short-term platforms", inherited: "Inherited house",
};

export const COMPANIES = ["none", "one_sa", "multiple_sa", "srl", "dormant_sa", "delinquent_sa", "foreign_llc"] as const;
export type CompanyKind = (typeof COMPANIES)[number];
export const COMPANY_WEIGHTS: Array<[CompanyKind, number]> = [
  ["none", 50], ["one_sa", 18], ["multiple_sa", 5], ["srl", 10], ["dormant_sa", 7], ["delinquent_sa", 6], ["foreign_llc", 4],
];

export const VEHICLES = ["none", "imported", "local", "motorcycle", "overdue_marchamo"] as const;
export type VehicleKind = (typeof VEHICLES)[number];
export const VEHICLE_WEIGHTS: Array<[VehicleKind, number]> = [["none", 35], ["imported", 15], ["local", 35], ["motorcycle", 8], ["overdue_marchamo", 7]];

export const EMPLOYEES = ["none", "domestic", "gardener", "small_business"] as const;
export type EmployeeKind = (typeof EMPLOYEES)[number];
export const EMPLOYEE_WEIGHTS: Array<[EmployeeKind, number]> = [["none", 60], ["domestic", 18], ["gardener", 14], ["small_business", 8]];

export const PROVINCES = ["San José", "Alajuela", "Cartago", "Heredia", "Guanacaste", "Puntarenas", "Limón"] as const;
export const PLACES: Record<(typeof PROVINCES)[number], string[]> = {
  "San José": ["Escazú", "Santa Ana", "San José"],
  Alajuela: ["Atenas", "Grecia", "San Ramón"],
  Cartago: ["Orosi", "Turrialba"],
  Heredia: ["Heredia", "San Rafael"],
  Guanacaste: ["Nosara", "Tamarindo", "Playas del Coco"],
  Puntarenas: ["Dominical", "Ojochal", "Jacó"],
  Limón: ["Puerto Viejo", "Cahuita"],
};

/** Combinations that could read as a public figure; never generated. */
export const BLOCKED_NAMES = new Set([
  "Omar Khoury", "Arjun Kapoor", "Kenji Tanaka", "Avi Kaplan", "Robert Hollis", "Lars Müller", "Malik Ellis",
]);
