#!/usr/bin/env python3
"""
scripts/importCountryResearch.py
──────────────────────────────────────────────────────────────────────────
Imports the obligation rules and free-check questions from
docs/research/<country>.md (the two JSON blocks in each file) into
API/countries/rules/<code>.ts, normalized to API/countries/rules/engine.ts.

    python3 scripts/importCountryResearch.py            # write the six files
    python3 scripts/importCountryResearch.py --check    # validate only

The research files use slightly different shapes per country (due vs
dueRule, plain vs whatThisUsuallyMeans, "or"/"any"/"anyOf" conditions,
answer values that are not the question's option values). Everything that
is not a mechanical mapping is listed below, per country, in SPEC: extra
questions (source "ilp") for condition keys the free check does not ask,
option `sets` that turn an answer into the facts the rules test, and
per-rule overrides for conditions and due rules that are written as text.
Every override is a translation of the research, never a new legal fact.

Re-run after editing a research file, then run the server tests
(test/countryRules_test.ts checks every rule's conditions against the
questions and computes every due kind).
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
RESEARCH = os.path.join(os.path.dirname(SERVER), "docs", "research")
OUT = os.path.join(SERVER, "API", "countries", "rules")

FILES = {"CO": "colombia", "CR": "costa-rica", "PA": "panama", "MX": "mexico", "ES": "spain", "PT": "portugal"}
YES_NO = [{"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}]
YES_NO_UNSURE = YES_NO + [{"value": "unsure", "label": "I am not sure"}]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

AREA = {"companies": "corporate", "company": "corporate", "corporate": "corporate", "vehicles": "vehicle", "vehicle": "vehicle",
        "labor": "employment", "employment": "employment", "family": "estate", "estate": "estate", "family_estate": "estate",
        "immigration": "immigration", "property": "property", "tax": "tax", "identity": "identity", "cross_border": "cross_border"}

# Plain "why we ask" lines, by answer key (all countries).
WHY = {
    "residencyStatus": "Residency rules set renewal dates and how long you can stay.",
    "residencyCategory": "Each residency category has its own conditions to keep.",
    "residencyProgram": "Each residency program has its own renewal steps and dates.",
    "ownsProperty": "Property owners usually pay local property tax and have a few yearly dates.",
    "hasCompany": "Companies have yearly filings, even when they do no business.",
    "ownsVehicle": "Vehicles have yearly fees, inspections and insurance dates.",
    "hasEmployees": "Employers, including households with staff, have monthly payments and yearly bonuses.",
    "rentsProperty": "Rental income usually has its own tax returns.",
    "rentsOutProperty": "Rental income usually has its own tax returns.",
    "isTaxResident": "Tax residents file a yearly return and some declarations that visitors do not.",
    "daysInColombia": "Spending more than 183 days in a year usually makes you a tax resident.",
    "region": "Some taxes and dates are set by the region or town.",
    "state": "Property tax, vehicle fees and some dates are set by each state.",
    "propertyDetails": "Some property situations add a tax or a concession fee.",
}

def humanize(key):
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key).replace("_", " ").lower()
    return words

ANCHORS = {
    "visaIssueOrEntryDate": "the date your visa was issued or you arrived",
    "visaExpiryDate": "the date your visa expires",
    "newVisaIssueDate": "the date your new visa was issued",
    "lastExitDate": "the day you last left the country",
    "firstMVisaIssueDate": "the date your first M visa was issued",
    "entryDate": "the date you last entered the country",
    "employmentStartOrEndDate": "the date the job started or ended",
    "soatExpiryDate": "the date your SOAT expires",
    "employmentAnniversary": "each employee's start date",
    "residencyExpiryDate": "the expiry date on your DIMEX",
    "residencyStartDate": "the date your residency was approved",
    "lastPropertyValueDeclarationDate": "your last property value declaration",
    "concessionExpiryDate": "the date the concession ends",
    "companyRegistrationDate": "the date the company was registered",
    "employeeStartDate": "each employee's start date",
    "visaStartDate": "the date your visa started",
    "carneExpiryDate": "the expiry date on your residency card",
    "provisionalApprovalDate": "the date your provisional residency was approved",
    "residencyResolutionDate": "the date of your residency resolution",
    "idCardExpiryDate": "the expiry date on your card",
    "occupancyOrRegistrationDate": "the occupancy or registration date of the property",
    "ownershipChangeDate": "the date ownership changed",
    "changeDate": "the date of the change",
    "fiscalYearEnd": "the company's year-end",
    "insuranceExpiryDate": "the date your policy expires",
    "licenseExpiryDate": "the expiry date on your licence",
    "entryDateWithResidencyVisa": "the date you entered with your residency visa",
    "residencyCardExpiry": "the expiry date on your resident card",
    "temporaryResidencyStartDate": "the date your temporary residency started",
    "dateOfChange": "the date of the change",
    "childResidencyCardExpiry": "the expiry date on your child's card",
    "visitorAuthorizedUntil": "the last day of your authorized stay",
    "tipMaxReturnDate": "the return date on your import permit",
    "autoPolicyExpiry": "the date your policy expires",
    "trustAnniversaryDate": "the anniversary of your bank trust",
    "trustStartDate": "the date your bank trust started",
    "deedSigningDate": "the date the deed was signed",
    "saleDeedDate": "the date of the sale deed",
    "efirmaIssueDate": "the date your e.firma was issued",
    "incorporationOrForeignEntryDate": "the date the company was formed or a foreign partner joined",
    "employeeHireDateAnniversary": "each employee's start date",
    "permitExpiryDate": "the expiry date on your residence card",
    "entryOrGrantDate": "the date you arrived or your permit was granted",
    "cardExpiryDate": "the expiry date on your card",
    "firstResidenceDate": "the date your first residence permit started",
    "padronRegistrationDate": "the date you registered at the town hall",
    "normalResidenceStartDate": "the date you became resident",
    "transferDate": "the date of the sale, gift or death",
    "saleDate": "the date of the sale",
    "dateOfDeath": "the date of death",
    "accountsApprovalDate": "the date the accounts were approved",
    "firstRegistrationDate": "the vehicle's first registration date",
    "policyRenewalDate": "the renewal date of your policy",
    "employmentStartDate": "the employee's start date",
    "visaIssueDate": "the date your visa was issued",
    "firstPermitIssueDate": "the date your first residence permit was issued",
    "leaseStartDate": "the date the lease started",
    "nhrStartYear": "the year your NHR status started",
    "vehicleRegistrationMonth": "the vehicle's registration month",
    "vehicleFirstRegistrationDate": "the vehicle's first registration date",
    "permitIssueDate": "the date your residence permit was issued",
    "employeeHolidayStart": "the start of the employee's holiday",
    "rutRegistrationDate": "the date the company got its RUT",
    "vehicleRegistrationDate": "the vehicle's registration date",
    "vehicleRenewalMonth": "the month on your plate sticker",
    "incorporationDate": "the company's registration date",
}

def anchor_label(k):
    return ANCHORS.get(k, "the " + humanize(k))

def md(s):
    m = re.fullmatch(r"(\d{2})-(\d{2})", s)
    assert m, s
    return [int(m.group(1)), int(m.group(2))]

def mdtext(m):
    return f"{MONTHS[m[0]-1]} {m[1]}"

def clean(s):
    """Copy rules: no em or en dashes in member-facing text."""
    if s is None:
        return ""
    s = str(s)
    s = re.sub(r"\s+[–—]\s+", ", ", s)
    s = s.replace("—", ", ").replace("–", "-")
    s = s.replace("−", "-")
    return s.strip()

def sentence(t):
    """Member-facing due text: capital first letter, ends with a period."""
    t = clean(t)
    if not t:
        return t
    t = t[0].upper() + t[1:]
    return t if t.endswith((".", ")")) else t + "."

def title_fix(t):
    t = clean(t)
    if not t.endswith("may require review"):
        t = t + " may require review"
    return t

# ─── Per-country spec ──────────────────────────────────────────────────────
# extra: questions added by ILP (stage profile unless said), so every
#        condition key has a question.
# sets:  {questionKey: {optionValue: {factKey: value or [values]}}}
# when:  {ruleId: condition} replaces the research condition (translation only).
# due:   {ruleId: (due, dueText or None)} replaces the mechanical due mapping.
# roll:  {ruleId: "next" | "previous"} weekend roll, where the research says so.

def q(key, question, options, stage="profile", type_="choice", showIf=None, optional=True, why=None, help_=None, dateAs=None):
    out = {"key": key, "stage": stage, "question": question, "type": type_, "options": options, "optional": optional, "source": "ilp"}
    if showIf: out["showIf"] = showIf
    if why: out["why"] = why
    if help_: out["help"] = help_
    if dateAs: out["dateAs"] = dateAs
    return out

def dateq(key, question, showIf, stage="check", why=None, help_=None):
    return q(key, question, [], stage=stage, type_="date", showIf=showIf, why=why, help_=help_)

SPEC = {
  "CO": {
    "extra": [
      dateq("visaExpiryDate", "What is the expiry date on your visa?", {"residencyStatus": ["visa_digital_nomad", "visa_V_long", "visa_M", "visa_R"]},
            why="Visa renewals and the cédula renewal are dated from it.", help_="It is on your e-visa. Skip this if you do not have it at hand."),
      dateq("entryDate", "When did you last enter Colombia?", {"residencyStatus": ["visitor"]},
            why="A visitor stay is counted from the day you enter.", help_="The date of your most recent entry stamp. Skip this if you are not sure."),
      q("visaBasis", "What is your Migrant (M) visa based on?", [
          {"value": "investor", "label": "An investment, such as property"}, {"value": "pensioner", "label": "A pension"},
          {"value": "spouse", "label": "A Colombian spouse or partner"}, {"value": "other", "label": "Something else"}],
        showIf={"residencyStatus": ["visa_M"]}),
      q("companyHasForeignShareholder", "Does your Colombian company have a shareholder from outside Colombia?", YES_NO_UNSURE, showIf={"hasCompany": ["yes"]}),
      q("hasColombianIncome", "Do you earn income from Colombia, such as rent or local fees?", YES_NO_UNSURE),
      q("employeeEarnsUpTo2SMMLV", "Does anyone who works for you earn up to two monthly minimum wages?", YES_NO_UNSURE,
        showIf={"hasEmployees": ["yes_colombian", "yes_foreign"]}),
    ],
    "sets": {
      "residencyStatus": {v: {"livesInColombia": "yes"} for v in ["visitor", "visa_digital_nomad", "visa_V_long", "visa_M", "visa_R", "visa_R_pre2022"]} | {"none": {"livesInColombia": "no"}},
      "daysInColombia": {"gt183": {"isTaxResident": "yes"}, "lt120": {"isTaxResident": "no"}, "120to183": {"isTaxResident": "unsure"}, "unsure": {"isTaxResident": "unsure"}},
      "ownsProperty": {"bogota": {"ownsProperty": "yes", "propertyCity": "bogota"}, "medellin": {"ownsProperty": "yes", "propertyCity": "medellin"},
                       "other": {"ownsProperty": "yes", "propertyCity": "other"}},
      "boughtWithForeignFunds": {"yes_registered": {"boughtWithForeignFunds": "yes"}, "yes_unsure": {"boughtWithForeignFunds": "yes"}},
      "rentsProperty": {"short_term": {"rentsProperty": "yes", "rentsShortTerm": "yes"}, "long_term": {"rentsProperty": "yes", "rentsShortTerm": "no"}},
      "ownsVehicle": {"bogota": {"ownsVehicle": "yes", "vehicleRegisteredIn": "bogota"}, "antioquia": {"ownsVehicle": "yes", "vehicleRegisteredIn": "antioquia"},
                      "other": {"ownsVehicle": "yes", "vehicleRegisteredIn": "other"}},
      "hasEmployees": {"yes_colombian": {"hasEmployees": "yes", "employsForeigners": "no"}, "yes_foreign": {"hasEmployees": "yes", "employsForeigners": "yes"}},
    },
    "when": {},
    "due": {
      "CO_IMM_RESIDENT_TRASPASO_2026": ({"kind": "once", "dates": ["2026-10-31"]}, "Before October 31, 2026. No further extension had been published by the research date."),
      "CO_IMM_R_ABSENCE": ({"kind": "relative", "anchor": "lastExitDate", "years": 2, "windowStartDays": 640}, "After more than 2 continuous years outside Colombia, counted from the day you last left."),
      "CO_IMM_M_ABSENCE": ({"kind": "relative", "anchor": "lastExitDate", "days": 180, "windowStartDays": 150}, "After more than 180 continuous days outside Colombia in any 365."),
      "CO_LAB_VACATION": ({"kind": "relative", "anchor": "employmentAnniversary", "years": 1, "annual": True}, "Each year on the employee's work anniversary (15 business days of paid vacation)."),
      "CO_IMM_M_TO_R": ({"kind": "relative", "anchor": "firstMVisaIssueDate", "years": 5}, "About 5 years after your first M visa (3 years for spouses of Colombians, 2 for parents of Colombians)."),
      "CO_IMM_VISITOR_STAY": ({"kind": "relative", "anchor": "entryDate", "days": 90}, "90 days after you enter, extendable up to 180 days a year."),
      "CO_PROP_PREDIAL_BOGOTA": ({"kind": "installments", "dates": [[4, 17], [7, 10]]}, "Early-payment discount until April 17, final date July 10 (2026 calendar). Installment plans have their own dates."),
      "CO_PROP_PREDIAL_MEDELLIN": ({"kind": "windows", "windows": [{"start": [2, 13], "end": [3, 12]}, {"start": [4, 30], "end": [5, 29]}, {"start": [7, 31], "end": [8, 31]}, {"start": [10, 30], "end": [12, 1]}]},
                                   "Quarterly bills; each has a window without surcharge (2026 calendar)."),
      "CO_PROP_PREDIAL_OTHER": ({"kind": "windows", "windows": [{"start": [1, 1], "end": [6, 30]}]}, "Set by each municipality; usually in the first half of the year."),
      "CO_CO_INCOME_TAX": ({"kind": "byIdDigits", "idName": "NIT", "ranges": [{"start": [5, 12], "end": [5, 26]}, {"start": [7, 9], "end": [7, 24]}]},
                           "Two installments, in May and July, on a day set by the last digit of the company's NIT (2026 calendar). Large taxpayers have other dates."),
      "CO_CO_ICA": ({"kind": "ongoing"}, "Set by each municipality. In Medellín (2026) returns were due from April 17 to April 30 by the last digit of the NIT."),
      "CO_CO_RUB": ({"kind": "ongoing"}, "Within 2 months of the company's RUT registration, then updated when owners change (checked each quarter)."),
      "CO_CO_ANNUAL_MEETING": ({"kind": "annual", "on": [3, 31]}, "By March 31 each year, unless the bylaws set another date."),
      "CO_TAX_RESIDENCY_183": ({"kind": "ongoing"}, "Watch the count once you reach about 150 days in any 365."),
      "CO_TAX_RENTA_INDIVIDUAL": ({"kind": "byIdDigits", "idName": "NIT", "ranges": [{"start": [8, 12], "end": [10, 26]}]},
                                  "Between August 12 and October 26, on a day set by the last two digits of your NIT (2026 calendar)."),
      "CO_VEH_RTM": ({"kind": "ongoing"}, "First inspection 6 years after registration for private cars (5 for cars registered after May 19, 2023; 2 for motorcycles), then every year."),
      "CO_VEH_TAX_BOGOTA": ({"kind": "installments", "dates": [[5, 15], [7, 24]]}, "Early-payment discount until May 15, final date July 24 (2026 calendar)."),
      "CO_VEH_TAX_ANTIOQUIA": ({"kind": "annual", "on": [4, 30]}, "Discount for paying by about April 30 (2026 calendar)."),
      "CO_LAB_PILA": ({"kind": "monthlyBusinessDays", "from": 2, "to": 16}, "Each month, between the 2nd and the 16th business day, on a day set by the last two digits of your ID."),
      "CO_LAB_REFORM_2025": ({"kind": "once", "dates": ["2026-07-01", "2026-07-15"]}, "Sunday surcharge to 90% from July 1, 2026; 42-hour week from July 15, 2026; a later step to 100% is expected."),
      "CO_PROP_TITLE_CHECK": ({"kind": "ongoing"}, "Once a year is a good habit; it is not a legal deadline."),
      "CO_EST_WILL_REVIEW": ({"kind": "ongoing"}, "Every few years, and after a marriage, divorce, birth or property purchase."),
    },
    "estimated": {"CO_PROP_PREDIAL_BOGOTA": 2026, "CO_PROP_PREDIAL_MEDELLIN": 2026, "CO_CO_INCOME_TAX": 2026, "CO_TAX_RENTA_INDIVIDUAL": 2026, "CO_VEH_TAX_BOGOTA": 2026, "CO_VEH_TAX_ANTIOQUIA": 2026},
    "roll": {},
  },
  "CR": {
    "extra": [
      q("residencyExpired", "Has your DIMEX or stay already expired?", YES_NO, showIf={"residencyStatus": ["temporary", "permanent", "digital_nomad"]}),
      q("drivesInCountry", "Do you drive in Costa Rica?", YES_NO),
      q("propertyUse", "How do you use the property?", [
          {"value": "residence", "label": "I live in it"}, {"value": "vacation_home", "label": "Vacation home"},
          {"value": "rental", "label": "I rent it out"}, {"value": "other", "label": "Land or other use"}], showIf={"ownsProperty": ["yes"]}),
      q("companyType", "What kind of company is it?", [
          {"value": "SA", "label": "Sociedad anónima (S.A.)"}, {"value": "SRL", "label": "Limitada (S.R.L.)"}, {"value": "unsure", "label": "I am not sure"}],
        showIf={"hasCompany": ["active", "inactive", "unsure"]}),
      q("companyCreatedThisYear", "Was the company registered this year?", YES_NO, showIf={"hasCompany": ["active", "inactive", "unsure"]}),
      q("hasLocalBusinessIncome", "Do you earn business or self-employment income in Costa Rica?", YES_NO_UNSURE),
      q("rentAboveVatThreshold", "Is the monthly rent above about ₡693,000 (1.5 base salaries)?", YES_NO_UNSURE, showIf={"rentsProperty": ["long_term", "both"]}),
      q("planningImport", "Are you planning to bring a vehicle or household goods into Costa Rica?", YES_NO),
      q("spouseIsCostaRican", "Is your spouse Costa Rican?", YES_NO),
      q("marriedAbroad", "Did you marry outside Costa Rica?", YES_NO, showIf={"spouseIsCostaRican": ["yes"]}),
    ],
    "sets": {
      "propertyDetails": {"held_by_company": {"propertyHeldByCompany": "yes"}, "luxury_over_threshold": {"luxuryThreshold": "yes"},
                          "maritime_concession": {"maritimeZoneConcession": "yes"}, "unsure": {"luxuryThreshold": "unsure"}},
      "hasCompany": {"active": {"hasCompany": "yes", "companyActivity": "active"}, "inactive": {"hasCompany": "yes", "companyActivity": "inactive"},
                     "unsure": {"hasCompany": "yes", "companyActivity": "unsure"}},
      "ownsVehicle": {d: {"ownsVehicle": "yes", "plateLastDigit": d} for d in "1234567890"},
    },
    "addOptions": {"ownsVehicle": [{"value": "yes", "label": "Yes, but I do not know the last digit of the plate"}]},
    "when": {},
    "due": {
      "CR_IMM_TEMP_RENEWAL": ({"kind": "relative", "anchor": "residencyExpiryDate", "days": -90, "windowStartDays": -120}, "Renewal can usually be started up to about 3 months before the expiry date on your DIMEX."),
      "CR_IMM_PERM_DIMEX_RENEWAL": ({"kind": "relative", "anchor": "residencyExpiryDate", "days": -90, "windowStartDays": -120}, "Up to about 3 months before the card expires."),
      "CR_IMM_NOMAD_STAY_EXPIRY": ({"kind": "relative", "anchor": "residencyExpiryDate", "days": -60}, "60 days before the stay ends, to decide whether to extend, change category or leave."),
      "CR_IMM_LATE_RENEWAL_WINDOW": ({"kind": "relative", "anchor": "residencyExpiryDate", "days": 0}, "From the expiry date. Sources disagree on how long the late window lasts (3 or 6 months), so act right away."),
      "CR_LAB_VACATION": ({"kind": "relative", "anchor": "employeeStartDate", "days": 350, "annual": True}, "Yearly on each employee's work anniversary (after 50 weeks)."),
      "CR_IMM_CCSS_CONTRIBUTIONS": ({"kind": "monthly", "day": None}, None),
      "CR_PROP_ZMT_CANON": ({"kind": "ongoing"}, None),
      "CR_VEH_RTV": ({"kind": "monthByAnswer", "answer": "plateLastDigit", "map": {str(d): (d if d else 10) for d in range(10)}},
                     "In the month set by the last digit of the plate (1 is January, 9 is September, 0 is October); plates ending in 1 and 2 may go a month early."),
    },
    "estimated": {},
    "roll": {"CR_CORP_ENTITY_TAX": "next", "CR_CORP_INCOME_TAX_RETURN": "next", "CR_TAX_PERSONAL_INCOME_RETURN": "next", "CR_PROP_LUXURY_HOME_TAX": "next",
             "CR_TAX_RENTAL_INCOME": "next", "CR_TAX_VAT_RENTAL": "next", "CR_CORP_EDUCATION_STAMP": "next", "CR_CORP_INACTIVE_RETURN": "next",
             "CR_CORP_FORM_270": "next", "CR_CORP_PARTIAL_PAYMENTS": "previous"},
  },
  "PA": {
    "extra": [
      q("citizenship", "Which citizenship do you hold?", [
          {"value": "US", "label": "United States"}, {"value": "CA", "label": "Canada"}, {"value": "other", "label": "Another country"}]),
      q("drivesInPanama", "Do you drive in Panama?", YES_NO),
      q("propertyBuiltOrBoughtNew", "Did you build the property or buy it new from a developer?", YES_NO_UNSURE,
        showIf={"ownsProperty": ["yes_primary_home", "yes_second_home", "yes_through_company"]}),
      q("planningToSell", "Are you planning to sell property in Panama?", YES_NO, showIf={"ownsProperty": ["yes_primary_home", "yes_second_home", "yes_through_company"]}),
      q("hasPanamaDriverLicense", "Do you have a Panamanian driver's licence?", YES_NO),
    ],
    "sets": {
      "ownsProperty": {v: {"ownsProperty": "yes", "propertyHolding": v} for v in ["yes_primary_home", "yes_second_home", "yes_through_company"]},
      "hasCompany": {"both": {"hasCompany": ["sociedad_anonima", "private_interest_foundation", "both"]}},
    },
    "keyDateAs": {"by": "residencyStatus", "map": {"tourist": "entryDate", "application_pending": "carneExpiryDate", "provisional_resident": "carneExpiryDate", "permanent_resident": "idCardExpiryDate"}},
    "when": {
      "PA_IMM_TOURIST_STAY": {"all": {"residencyStatus": ["tourist"], "citizenship": ["US", "CA"]}},
      "PA_PROP_PRIMARY_HOME_REGISTRATION": {"all": {"propertyHolding": ["yes_primary_home"]}},
    },
    "due": {
      "PA_IMM_REMOTE_WORKER_EXPIRY": ({"kind": "relative", "anchor": "visaStartDate", "months": 9, "windowStartDays": None}, "9 months after the visa starts; one extension is possible."),
      "PA_IMM_PROVISIONAL_CARNE_EXPIRY": ({"kind": "relative", "anchor": "carneExpiryDate", "windowStartDays": -60}, None),
      "PA_IMM_FN_PERMANENT_APPLICATION": ({"kind": "relative", "anchor": "provisionalApprovalDate", "months": 24}, "Apply before the 2-year provisional residency ends."),
      "PA_IMM_QI_ANNUAL_MICI": ({"kind": "relative", "anchor": "residencyResolutionDate", "annual": True, "windowStartDays": -30}, "Within the 30 days before each anniversary of your residency resolution."),
      "PA_IMM_PERMANENT_CARNE_CHECK": ({"kind": "relative", "anchor": "idCardExpiryDate", "windowStartDays": -90}, None),
      "PA_CORP_TASA_UNICA": ({"kind": "annualByAnswer", "answer": "incorporationHalf", "map": {"jan_jun": [7, 15], "jul_dec": [1, 15]}},
                             "July 15 each year if registered January to June; January 15 if registered July to December."),
      "PA_CORP_INCOME_TAX_RETURN": ({"kind": "relative", "anchor": "fiscalYearEnd", "months": 3, "fallback": [3, 31]}, "3 months after the company's year-end (March 31 for a calendar year)."),
      "PA_VEH_ANNUAL_PLATE_RENEWAL": ({"kind": "monthByAnswer", "answer": "vehicleRenewalMonth"}, "Each year in the month on your plate sticker."),
      "PA_VEH_REVISADO": ({"kind": "monthByAnswer", "answer": "vehicleRenewalMonth", "offsetDays": -30}, "Before the plate renewal month each year."),
      "PA_VEH_INSURANCE": ({"kind": "relative", "anchor": "insuranceExpiryDate", "windowStartDays": -30}, None),
      "PA_VEH_LICENSE_RENEWAL": ({"kind": "relative", "anchor": "licenseExpiryDate", "windowStartDays": -30}, None),
      "PA_LAB_CSS_MONTHLY": ({"kind": "ongoing"}, "Each month; the exact payment day was not confirmed."),
    },
    "estimated": {},
    "roll": {},
  },
  "MX": {
    "labels": {
      "residencyStatus": {"visitor": "Visitor (tourist card or FMM)", "residency_visa_not_yet_exchanged": "I have a residency visa from a consulate and have not exchanged it for a card yet",
                          "temporary": "Temporary resident", "permanent": "Permanent resident", "mexican_citizen": "Mexican citizen", "not_living_in_mexico": "I do not live in Mexico"},
      "ownsProperty": {"yes": "Yes", "no": "No", "buying_now": "I am buying now", "selling_now": "I am selling now"},
      "holdingStructure": {"fideicomiso": "Bank trust (fideicomiso)", "direct_title": "In my own name", "mexican_company": "Through a Mexican company", "not_sure": "I am not sure"},
      "propertyInRestrictedZone": {"yes": "Yes", "no": "No", "not_sure": "I am not sure"},
      "rentsOutProperty": {"no": "No", "long_term": "Yes, long-term", "short_term_platform": "Yes, short-term on a platform like Airbnb", "both": "Both"},
      "hasCompany": {"yes": "Yes", "no": "No", "planning": "I am planning one"},
      "ownsVehicle": {"no": "No", "mexican_plates": "Yes, with Mexican plates", "foreign_plates_with_TIP": "Yes, foreign plates with an import permit (TIP)",
                      "foreign_plates_no_permit": "Yes, foreign plates without a permit"},
      "hasEmployees": {"no": "No", "domestic_worker": "A household worker", "company_staff": "Staff in a company", "both": "Both"},
      "hasMexicanWill": {"yes": "Yes", "no": "No", "not_sure": "I am not sure"},
      "state": {"other": "Another state"},
    },
    "extra": [
      dateq("entryDateWithResidencyVisa", "When did you enter Mexico with your residency visa?", {"residencyStatus": ["residency_visa_not_yet_exchanged"]},
            why="The card exchange is usually due within 30 days of that entry.", help_="The date on your entry stamp or FMM. Skip this if you are not sure."),
      dateq("residencyCardExpiry", "What is the expiry date on your resident card?", {"residencyStatus": ["temporary"]},
            why="Renewal is usually filed in the 30 days before the card expires.", help_="It is printed on the card. Skip this if you do not have it at hand."),
      dateq("visitorAuthorizedUntil", "What is the last day of your authorized stay?", {"residencyStatus": ["visitor"]},
            why="Visitors must leave or change status by that date.", help_="It is on your FMM or entry record. Skip this if you are not sure."),
      q("hasMinorChildrenWithResidency", "Do you have children under 18 with Mexican residency?", YES_NO, showIf={"residencyStatus": ["permanent"]}),
      q("hasEfirma", "Do you have an e.firma from the SAT?", YES_NO_UNSURE),
      q("companyHasForeignShareholders", "Does the company have shareholders from outside Mexico?", YES_NO_UNSURE, showIf={"hasCompany": ["yes"]}),
      q("companyAbove110MThreshold", "Are the company's assets or yearly income above MXN 110 million?", YES_NO_UNSURE, showIf={"hasCompany": ["yes"]}),
      q("citizenship", "Which citizenship do you hold?", [
          {"value": "US", "label": "United States"}, {"value": "CA", "label": "Canada"}, {"value": "other", "label": "Another country"}]),
      q("mexicanTaxResidentWithIncome", "Are you a Mexican tax resident with income in Mexico?", YES_NO_UNSURE),
    ],
    "sets": {
      "ownsProperty": {"buying_now": {"ownsProperty": "no", "purchasingProperty": "yes"}, "selling_now": {"ownsProperty": "yes", "sellingProperty": "yes"}},
      "rentsOutProperty": {"long_term": {"rentsOutProperty": ["yes", "long_term"]}, "short_term_platform": {"rentsOutProperty": ["yes", "short_term_platform"]},
                           "both": {"rentsOutProperty": ["yes", "long_term", "short_term_platform", "both"]}},
      "ownsVehicle": {"mexican_plates": {"ownsVehicle": "yes", "vehiclePlates": "mexican"}, "foreign_plates_with_TIP": {"ownsVehicle": "yes", "vehiclePlates": "foreign_with_TIP"},
                      "foreign_plates_no_permit": {"ownsVehicle": "yes", "vehiclePlates": "foreign_no_permit"}},
      "hasEmployees": {"both": {"hasEmployees": ["domestic_worker", "company_staff", "both"]}},
      "state": {"CDMX": {"vehicleState": "CDMX"}, "Estado de México": {"vehicleState": "EdoMex"}},
    },
    "when": {
      # Research: {"citizenship": "US", "or": {"holdingStructure": "fideicomiso"}}. A US filing applies to US persons only.
      "MX_XB_US_FIDEICOMISO_REPORTING": {"all": {"citizenship": ["US"]}},
      # Research lists "Megalopolis" too; the check only asks for CDMX and Estado de México among those states.
      "MX_VEH_VERIFICACION": {"all": {"ownsVehicle": ["yes"], "vehiclePlates": ["mexican"], "vehicleState": ["CDMX", "EdoMex"]}},
    },
    "due": {
      "MX_IMM_TEMP_RENEWAL": ({"kind": "relative", "anchor": "residencyCardExpiry", "windowStartDays": -30}, "In the 30 days before the card expires."),
      "MX_IMM_TEMP_4YR_LIMIT": ({"kind": "relative", "anchor": "temporaryResidencyStartDate", "days": 1461, "windowStartDays": 1371}, "4 years after your temporary residency started."),
      "MX_IMM_PERM_MINOR_RENEWAL": ({"kind": "relative", "anchor": "childResidencyCardExpiry", "windowStartDays": -30}, None),
      "MX_IMM_VISITOR_STAY": ({"kind": "relative", "anchor": "visitorAuthorizedUntil", "windowStartDays": -14}, None),
      "MX_VEH_TIP_EXPIRY": ({"kind": "relative", "anchor": "tipMaxReturnDate", "windowStartDays": -30}, None),
      "MX_VEH_VERIFICACION": ({"kind": "ongoing"}, "Twice a year, in months set by the last digit of the plate (CDMX and Estado de México)."),
      "MX_VEH_INSURANCE": ({"kind": "relative", "anchor": "autoPolicyExpiry", "windowStartDays": -15}, None),
      "MX_PROP_PREDIAL": ({"kind": "annual", "on": [1, 31]}, "Discount for paying the year by the end of January (some cities, like CDMX, also allow installments)."),
      "MX_PROP_FIDEICOMISO_FEE": ({"kind": "relative", "anchor": "trustAnniversaryDate", "annual": True, "windowStartDays": -30}, "Each year on the trust's anniversary."),
      "MX_PROP_FIDEICOMISO_TERM": ({"kind": "relative", "anchor": "trustStartDate", "years": 50, "windowStartDays": 17897}, "50 years after the trust started; it can be extended."),
      "MX_TAX_RENTAL_MONTHLY": ({"kind": "monthly", "day": 17}, "By the 17th of the following month."),
      "MX_TAX_RENTAL_PLATFORM": ({"kind": "ongoing"}, "Monthly; the state lodging tax follows each state's rules."),
      "MX_TAX_EFIRMA": ({"kind": "relative", "anchor": "efirmaIssueDate", "days": 1461, "windowStartDays": 1401}, "4 years after your e.firma was issued."),
      "MX_CO_MONTHLY_TAX": ({"kind": "monthly", "day": 17}, "By the 17th of the following month."),
      "MX_CO_RNIE_QUARTERLY": ({"kind": "ongoing"}, "Within 10 business days after March 31, June 30, September 30 and December 31, only when the thresholds are met."),
      "MX_CO_RNIE_ANNUAL": ({"kind": "annual", "on": [4, 30]}, "April 30 (May 31 for company names starting K to Z)."),
      "MX_LAB_IMSS_DOMESTIC": ({"kind": "ongoing"}, "Per the payment period you choose: daily, monthly, every two months, every six months or yearly."),
      "MX_LAB_VACATION": ({"kind": "relative", "anchor": "employeeHireDateAnniversary", "annual": True, "windowStartDays": -30}, "Each year on the employee's work anniversary."),
      "MX_LAB_WORKWEEK_2027": ({"kind": "once", "dates": ["2027-01-01"]}, "January 1, 2027: 46 hours; then 44 in 2028, 42 in 2029 and 40 in 2030."),
      "MX_EST_WILL": ({"kind": "annual", "on": [9, 1]}, "Any time; notaries offer discounts in September (Mes del Testamento)."),
      "MX_XB_US_FIDEICOMISO_REPORTING": ({"kind": "annual", "on": [4, 15]}, "April 15 with your US return (FBAR has an automatic extension to October 15)."),
    },
    "estimated": {},
    "roll": {},
  },
  "ES": {
    "extra": [
      q("lifeEvent", "Has any of these happened recently, or is about to?", [
          {"value": "sale", "label": "Selling property in Spain"}, {"value": "gift", "label": "Giving property as a gift"},
          {"value": "inheritance", "label": "Inheriting property in Spain"}, {"value": "death_of_relative", "label": "The death of a close relative"},
          {"value": "none", "label": "None of these"}], type_="multi"),
      q("hasForeignCryptoOver50k", "Do you hold more than EUR 50,000 in cryptocurrency on exchanges outside Spain?", YES_NO_UNSURE,
        stage="check", showIf={"hasForeignAssetsOver50k": ["yes", "notSure"]}, why="Crypto held abroad has its own declaration, due with the foreign assets one."),
    ],
    "sets": {
      "ownsVehicle": {"spanishPlated": {"ownsVehicle": "yes"}, "foreignLicenseOnly": {"ownsVehicle": "no", "drivesWithForeignLicense": "yes"},
                      "both": {"ownsVehicle": "yes", "drivesWithForeignLicense": "yes"}, "no": {"ownsVehicle": "no", "drivesWithForeignLicense": "no"}},
      "isTaxResident": {"yes": {"spendsTimeInSpain": "yes"}, "notSure": {"spendsTimeInSpain": "yes"}, "no": {"spendsTimeInSpain": "no"}},
      "residencyStatus": {v: {"spendsTimeInSpain": "yes"} for v in ["nonLucrative", "digitalNomad", "goldenVisa", "longTerm", "other"]},
    },
    "when": {
      "ES_PROP_PLUSVALIA": {"all": {"ownsProperty": ["yes"], "lifeEvent": ["sale", "gift", "inheritance"]}},
      "ES_PROP_NONRES_SALE": {"all": {"ownsProperty": ["yes"], "isTaxResident": ["no"], "lifeEvent": ["sale"]}},
      "ES_TAX_INHERITANCE": {"all": {"lifeEvent": ["death_of_relative", "inheritance"]}, "anyOf": [{"ownsProperty": ["yes"]}, {"isTaxResident": ["yes"]}]},
      # Product note in the research: the Basque Country and Navarra set their own tax dates.
      "ES_TAX_IRPF": {"all": {"isTaxResident": ["yes"]}, "unless": {"region": ["paisVasco_navarra"]}},
      "ES_TAX_WEALTH": {"all": {}, "anyOf": [{"netWealthBand": ["2to3M"]}, {"netWealthBand": ["over3M"]}], "unless": {"region": ["paisVasco_navarra"]}},
    },
    "due": {
      "ES_IMM_NLV_RENEWAL": ({"kind": "relative", "anchor": "permitExpiryDate", "days": 90, "windowStartDays": -60}, "From 60 days before the permit expires until 90 days after (filing late may open a sanction procedure)."),
      "ES_IMM_TIE_RENEWAL": ({"kind": "relative", "anchor": "cardExpiryDate", "days": 90, "windowStartDays": -60}, "From 60 days before the card expires until 90 days after."),
      "ES_IMM_DNV_RENEWAL": ({"kind": "relative", "anchor": "permitExpiryDate", "days": -60}, None),
      "ES_IMM_GOLDEN_VISA": ({"kind": "relative", "anchor": "permitExpiryDate", "days": -90}, None),
      "ES_PROP_IBI": ({"kind": "ongoing"}, "Once a year in a payment period set by your town hall (for example September 1 to November 30 in Las Rozas, Madrid)."),
      "ES_PROP_WASTE": ({"kind": "ongoing"}, "Once a year in a period set by your town hall (for example June 1 to July 31 in Las Rozas)."),
      "ES_PROP_NONRES_IMPUTED": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [12, 31]}]}, "2025 income: by December 31, 2026. From 2026 income: April 1 to December 31 of the following year (direct debit until December 23)."),
      "ES_PROP_NONRES_RENTAL": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [4, 20]}]}, "Rent from October 2026 on: April 1 to April 20 of the following year (direct debit April 1 to 15)."),
      "ES_PROP_PLUSVALIA": ({"kind": "event", "trigger": "sale, gift or inheritance"}, "30 working days after a sale or gift; 6 months after a death for an inheritance (6 more if asked for in time)."),
      "ES_PROP_NONRES_SALE": ({"kind": "relative", "anchor": "saleDate", "months": 4, "windowStartDays": 30}, "In months 2 to 4 after the sale."),
      "ES_TAX_IRPF": ({"kind": "windows", "windows": [{"start": [4, 8], "end": [6, 30]}]}, "Early April to June 30 (2026 campaign: April 8 to June 30; direct debit by June 25)."),
      "ES_TAX_WEALTH": ({"kind": "windows", "windows": [{"start": [4, 8], "end": [6, 30]}]}, "Same window as the income tax return, to June 30 (direct debit to June 25)."),
      "ES_CO_ACCOUNTS_APPROVAL": ({"kind": "relative", "anchor": "fiscalYearEnd", "months": 6, "fallback": [6, 30]}, "Within 6 months of the year-end (June 30 for a calendar year)."),
      "ES_CO_ACCOUNTS_DEPOSIT": ({"kind": "relative", "anchor": "accountsApprovalDate", "months": 1, "fallback": [7, 30]}, "Within 1 month of approval (July 30 if approved June 30)."),
      "ES_CO_VAT_303": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [4, 20]}, {"start": [7, 1], "end": [7, 20]}, {"start": [10, 1], "end": [10, 20]}, {"start": [1, 1], "end": [1, 30]}]},
                        "April 1 to 20, July 1 to 20, October 1 to 20 and January 1 to 30; the yearly summary (Modelo 390) by January 30."),
      "ES_CO_WITHHOLDING": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [4, 20]}, {"start": [7, 1], "end": [7, 20]}, {"start": [10, 1], "end": [10, 20]}, {"start": [1, 1], "end": [1, 20]}]},
                            "April 1 to 20, July 1 to 20, October 1 to 20 and January 1 to 20."),
      "ES_VEH_ITV": ({"kind": "ongoing"}, "First at 4 years, then every 2 years, then every year once the car is over 10 years old."),
      "ES_VEH_IVTM": ({"kind": "ongoing"}, "Once a year in a period set by your town hall (for example April 1 to June 1 in Las Rozas)."),
      "ES_LAB_DOMESTIC_REGISTER": ({"kind": "event", "trigger": "before the first day of work"}, "Before the first day of work."),
      "ES_LAB_DOMESTIC_EXTRAPAY": ({"kind": "installments", "dates": [[6, 30], [12, 31]]}, "June 30 and December 31, unless agreed otherwise."),
    },
    "estimated": {"ES_TAX_IRPF": 2026},
    "roll": {"ES_PROP_NONRES_IMPUTED": "next", "ES_PROP_NONRES_RENTAL": "next", "ES_TAX_IRPF": "next", "ES_TAX_720": "next", "ES_TAX_721": "next",
             "ES_TAX_WEALTH": "next", "ES_TAX_SOLIDARITY": "next", "ES_CO_CIT_200": "next", "ES_CO_VAT_303": "next", "ES_CO_WITHHOLDING": "next"},
  },
  "PT": {
    "extra": [
      q("permitExpired", "Has your residence card already expired?", YES_NO, showIf={"residencyStatus": ["temporary_resident", "golden_visa"]}),
      q("hasNIF", "Do you have a Portuguese tax number (NIF)?", YES_NO),
      q("propertyType", "What kind of property is it?", [
          {"value": "apartment", "label": "An apartment"}, {"value": "house", "label": "A house"}, {"value": "land", "label": "Land"}, {"value": "other", "label": "Something else"}],
        showIf={"ownsProperty": ["yes", "company"]}),
      q("livesInPortugalPartYear", "Do you live in Portugal for part of the year?", YES_NO),
      q("hasForeignIncomeOrAccounts", "Do you have income or bank accounts outside Portugal?", YES_NO, showIf={"isTaxResident": ["yes"]}),
      q("worksInQualifyingRole", "Do you work in research, innovation or another role that qualifies for IFICI?", YES_NO_UNSURE, showIf={"isTaxResident": ["yes"]}),
      q("lifeEvent", "Has a close family member died recently?", [{"value": "death_in_family", "label": "Yes"}, {"value": "none", "label": "No"}]),
      q("estateHasPortugueseAssets", "Did they own property or other assets in Portugal?", YES_NO_UNSURE, showIf={"lifeEvent": ["death_in_family"]}),
      dateq("visaIssueDate", "When was your residence visa issued?", {"residencyStatus": ["residence_visa_holder"]},
            why="The visa is valid for 120 days, and the AIMA appointment must happen within it.", help_="It is on the visa in your passport. Skip this if you are not sure."),
    ],
    "sets": {
      "ownsProperty": {"company": {"ownsProperty": ["yes", "company"]}},
      "rentsOutProperty": {"long_term": {"rentsOutProperty": ["yes", "long_term"]}, "short_term": {"rentsOutProperty": ["yes", "short_term"]}},
      "ownsVehicle": {"yes": {"ownsVehicle": "yes", "drivesInPortugal": "yes"}, "drive_only": {"ownsVehicle": "no", "drivesInPortugal": "yes"}, "no": {"ownsVehicle": "no", "drivesInPortugal": "no"}},
      "taxRegime": {"nhr": {"hasNHR": "yes"}, "arrived_recently": {"becameResidentLastYear": "yes"}, "ifici": {"hasNHR": "no"}, "none": {"hasNHR": "no"}},
      "hasPortugueseWill": {"yes_home": {"hasPortugueseWill": ["no", "yes_home"]}},
    },
    "when": {},
    "due": {
      "PT_IMM_PERMIT_RENEWAL": ({"kind": "relative", "anchor": "permitExpiryDate", "days": -30, "windowStartDays": -90}, "Online with AIMA from 90 to 30 days before the card expires."),
      "PT_IMM_GOLDEN_VISA": ({"kind": "relative", "anchor": "permitExpiryDate", "days": -30, "windowStartDays": -90}, "Renewal every 2 years, filed before the card expires; stay days and the investment are checked."),
      "PT_PROP_IMI": ({"kind": "installments", "dates": [[5, 31], [8, 31], [11, 30]]}, "Under EUR 100: May 31. EUR 100 to 500: May 31 and November 30. Over EUR 500: May 31, August 31 and November 30. Moves to the next business day on a weekend."),
      "PT_PROP_AIMI": ({"kind": "annual", "on": [9, 30]}, "Payment by September 30; the joint-taxation election around May 31."),
      "PT_PROP_LEASE_COMMUNICATION": ({"kind": "relative", "anchor": "leaseStartDate", "endOfMonthAfter": 1}, "By the end of the month after the lease starts (same for changes and the end)."),
      "PT_PROP_RENT_RECEIPTS": ({"kind": "annual", "on": [2, 28]}, "A receipt for each rent payment; Modelo 44, for landlords exempt from receipts, by the end of February."),
      "PT_PROP_RENTAL_INCOME_TAX": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [6, 30]}]}, "With the yearly IRS return, April 1 to June 30."),
      "PT_TAX_IRS_RETURN": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [6, 30]}]}, "File April 1 to June 30; pay any tax due by August 31."),
      "PT_TAX_FOREIGN_INCOME_ACCOUNTS": ({"kind": "windows", "windows": [{"start": [4, 1], "end": [6, 30]}]}, "With the yearly IRS return, April 1 to June 30."),
      "PT_TAX_HOUSEHOLD_INVOICES": ({"kind": "installments", "dates": [[1, 15], [2, 25]]}, "Household details by January 15; e-Fatura invoice checks by February 25."),
      "PT_TAX_NHR_LEGACY": ({"kind": "ongoing"}, "NHR lasts 10 years from the year it started."),
      "PT_VEH_IUC": ({"kind": "ongoing"}, "In 2026, by the end of the vehicle's registration month. From 2027: October (or July and October above EUR 500). From 2028: April, July and October by amount."),
      "PT_VEH_IPO": ({"kind": "ongoing"}, "At 4, 6 and 8 years from first registration, then every year; up to 3 months early."),
      "PT_VEH_INSURANCE": ({"kind": "relative", "anchor": "policyRenewalDate"}, "On your policy's renewal date."),
      "PT_EMP_DOMESTIC_REGISTRATION": ({"kind": "relative", "anchor": "employmentStartDate"}, "When the job starts; the end of a job by the 10th of the following month."),
      "PT_EMP_DOMESTIC_CONTRIBUTIONS": ({"kind": "monthly", "day": 25}, "Between the 1st and the 25th of the following month."),
      "PT_EMP_HOLIDAY_SUBSIDY": ({"kind": "ongoing"}, "Before the employee's holiday."),
      "PT_EST_INHERITANCE_DECLARATION": ({"kind": "relative", "anchor": "dateOfDeath", "endOfMonthAfter": 3}, "By the end of the third month after the death."),
    },
    "estimated": {},
    "roll": {"PT_PROP_IMI": "next"},
  },
}

# ─── Research → normalized ─────────────────────────────────────────────────

def research(code):
    t = open(os.path.join(RESEARCH, FILES[code] + ".md"), encoding="utf-8").read()
    blocks = re.findall(r"```json\n(.*?)```", t, re.S)
    assert len(blocks) == 2, (code, len(blocks))
    date = re.search(r"(?:Research date|Compiled|research date)[^0-9]*(\d{4}-\d{2}-\d{2})", t)
    return json.loads(blocks[0]), json.loads(blocks[1]), (date.group(1) if date else "2026-10-27")

def as_list(v):
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, bool):
        return ["yes" if v else "no"]
    return [str(v)]

def norm_questions(code, raw):
    spec = SPEC[code]
    out = []
    for r in raw:
        key = r.get("answerKey") or r["id"]
        if code == "MX":
            key = key[3:] if key.startswith("mx_") else key
        typ = r.get("type") or "choice"
        typ = {"single": "choice", "choice": "choice", "multi": "multi", "date": "date", "month": "month"}[typ]
        opts = []
        if typ != "date":
            for o in r.get("options") or []:
                if isinstance(o, str):
                    lab = spec.get("labels", {}).get(key, {}).get(o, o)
                    opts.append({"value": o, "label": lab})
                else:
                    opts.append({"value": str(o["value"]), "label": clean(o["label"])})
        qd = {"key": key, "stage": "check", "question": clean(r["question"]), "type": typ, "options": opts,
              "optional": bool(r.get("optional")) or typ == "date", "source": "research"}
        if key in WHY:
            qd["why"] = WHY[key]
        si = r.get("showIf")
        if si:
            si = {(k[3:] if code == "MX" and k.startswith("mx_") else k): as_list(v) for k, v in si.items()}
            qd["showIf"] = si
        if code == "PA" and key == "keyDate":
            qd["dateAs"] = spec["keyDateAs"]
            qd["why"] = "Stay limits and card renewals are dated from it."
            qd["help"] = "Tourists: the date of your last entry stamp. Residents: the expiry date on your card. Skip this if you are not sure."
        if typ == "date" and "why" not in qd:
            qd["why"] = "Renewals are dated from it."
            qd["help"] = "It is printed on the card. Skip this if you do not have it at hand."
        # Spain "maps" become option sets (handled by SPEC sets).
        out.append(qd)
        fu = r.get("followUp")
        if fu:
            fkey = fu["id"]
            fq = {"key": fkey, "stage": "check", "question": clean(fu["question"]), "type": "month",
                  "options": [{"value": str(i + 1), "label": MONTHS[i]} for i in range(12)],
                  "showIf": {key: ["yes"]}, "optional": True, "source": "research",
                  "why": "The yearly plate renewal and inspection follow that month."}
            out.append(fq)
    for qd in spec["extra"]:
        out.append(dict(qd))
    # Options added by ILP to a research question (e.g. "Yes, but I do not know the plate digit").
    for qd in out:
        for o in spec.get("addOptions", {}).get(qd["key"], []):
            qd["options"].append(dict(o))
    # Apply sets.
    for qd in out:
        s = spec["sets"].get(qd["key"], {})
        for o in qd["options"]:
            if o["value"] in s:
                o["sets"] = s[o["value"]]
    return out

def cond_from(code, rid, aw):
    spec = SPEC[code]
    if rid in spec["when"]:
        return spec["when"][rid]
    allc, anyOf = {}, []
    for k, v in (aw or {}).items():
        if k in ("anyOf",):
            anyOf += [{kk: as_list(vv) for kk, vv in g.items()} for g in v]
        elif k == "or":
            # Mexico: {"a": x, "or": {"b": y}} means a OR b.
            anyOf.append({kk: as_list(vv) for kk, vv in v.items()})
        elif k == "any":
            for expr in v:
                if "!=" in expr:
                    kk, vv = expr.split("!=")
                    anyOf.append({kk: ["!" + vv]})
                else:
                    kk, vv = expr.split("=")
                    anyOf.append({kk: [vv]})
        else:
            allc[k] = as_list(v)
    if "or" in (aw or {}):
        # Move the plain keys into the first group of the OR.
        first = dict(allc)
        allc = {}
        anyOf.insert(0, first)
    out = {"all": allc}
    if anyOf:
        out["anyOf"] = anyOf
    return out

def due_from(code, rid, d, rule):
    spec = SPEC[code]
    text = d.get("description") or d.get("rule") or d.get("note") or d.get("trigger") or d.get("event") or ""
    if rid in spec["due"]:
        due, t = spec["due"][rid]
        due = {k: v for k, v in due.items() if not (v is None and k == "windowStartDays")}
        return due, clean(t or text)
    t = d.get("type")
    if t in ("fixed", "annual"):
        if d.get("window"):
            w = d["window"]
            return {"kind": "windows", "windows": [{"start": md(w[0]), "end": md(w[1])}]}, clean(text)
        if d.get("dates"):
            return {"kind": "installments", "dates": [md(x) for x in d["dates"]]}, clean(text)
        date = d.get("date")
        if date is None:
            return {"kind": "ongoing"}, clean(text)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            return {"kind": "once", "dates": [date]}, clean(text)
        due = {"kind": "annual", "on": md(date)}
        if d.get("windowStart"):
            due["windowStart"] = md(d["windowStart"])
        if d.get("firstYear"):
            due["firstYear"] = d["firstYear"]
        if not text:
            text = f"Each year by {mdtext(md(date))}."
        if d.get("alt"):
            text = f"{text} Also: {d['alt']}."
        return due, clean(text)
    if t == "fixed_window":
        return {"kind": "windows", "windows": [{"start": md(d["start"]), "end": md(d["end"])}]}, clean(text or f"{mdtext(md(d['start']))} to {mdtext(md(d['end']))} each year.")
    if t == "fixed_dates":
        return {"kind": "installments", "dates": [md(x) for x in d["dates"]]}, clean(text or "Each year on " + " and ".join(mdtext(md(x)) for x in d["dates"]) + ".")
    if t == "installments" and d.get("dates"):
        return {"kind": "installments", "dates": [md(x) for x in d["dates"]]}, clean(text or "Each year on " + ", ".join(mdtext(md(x)) for x in d["dates"]) + ".")
    if t == "monthly":
        day = d.get("dayOfMonth", d.get("day"))
        if not text:
            text = f"By the {day}th of each month." if day else "Each month."
        return {"kind": "monthly", "day": day}, clean(text)
    if t in ("relative", "window_relative"):
        anchor = d.get("anchor") or d.get("to")
        due = {"kind": "relative", "anchor": anchor}
        if "offsetDays" in d and d.get("unit") == "business":
            due["businessDays"] = d["offsetDays"]
        elif "offsetDays" in d:
            due["days"] = d["offsetDays"]
        if "offsetBusinessDays" in d: due["businessDays"] = d["offsetBusinessDays"]
        if "offsetMonths" in d: due["months"] = d["offsetMonths"]
        if "offsetYears" in d: due["years"] = d["offsetYears"]
        if "daysBefore" in d: due["days"] = -d["daysBefore"]
        if "daysAfter" in d: due["days"] = d["daysAfter"]
        if "monthsAfter" in d: due["months"] = d["monthsAfter"]
        if "yearsAfter" in d: due["years"] = d["yearsAfter"]
        if "windowEndOffsetDays" in d:
            due["windowStartDays"] = d["offsetDays"]
            due["days"] = d["windowEndOffsetDays"]
        if "windowStartDays" in d:
            due["windowStartDays"] = d["windowStartDays"]
            due["days"] = d.get("windowEndDays", 0)
        if "startDaysBefore" in d:
            due["windowStartDays"] = -d["startDaysBefore"]
            due["days"] = d["endDaysAfter"]
        if "remindBeforeDays" in d and "windowStartDays" not in due:
            due["windowStartDays"] = due.get("days", 0) - d["remindBeforeDays"]
        if "reminderOffsetDays" in d and "windowStartDays" not in due:
            due["windowStartDays"] = due.get("days", 0) + d["reminderOffsetDays"]
        if d.get("annual"):
            due["annual"] = True
        if d.get("defaultDate"):
            due["fallback"] = md(d["defaultDate"])
        if not text:
            text = rel_text(due)
        return due, clean(text)
    if t == "byAnswer":
        return {"kind": "monthByAnswer", "answer": d["answer"], "map": {k: int(v) for k, v in d["map"].items()}}, clean(text)
    if t == "ref":
        ref = d["ref"] if isinstance(d["ref"], str) else d["ref"][0]
        return {"kind": "sameAs", "ruleId": ref}, clean(text or "Same date as the related return.")
    if t == "event":
        return {"kind": "event", "trigger": humanize(text) if re.fullmatch(r"[A-Za-z]+", text or "") else clean(text)}, clean(event_text(text))
    if t in ("ongoing", "recurring", "varies", "mixed"):
        return {"kind": "ongoing"}, clean(text or "Ongoing; there is no single date.")
    raise SystemExit(f"{rid}: unmapped due rule {d}")

def event_text(t):
    if re.fullmatch(r"[A-Za-z]+", t or ""):
        return "When it happens: " + humanize(t) + "."
    return t

def rel_text(due):
    a = anchor_label(due["anchor"])
    parts = []
    if due.get("years"): parts.append(f"{due['years']} years")
    if due.get("months"): parts.append(f"{due['months']} months")
    if due.get("businessDays"): parts.append(f"{due['businessDays']} business days")
    days = due.get("days")
    if days:
        parts.append(f"{abs(days)} days")
    if not parts:
        base = f"On {a}"
    elif days and days < 0:
        base = f"{', '.join(parts)} before {a}"
    else:
        base = f"{', '.join(parts)} after {a}"
    base = base[0].upper() + base[1:]
    if due.get("annual"):
        base += ", every year"
    return base + "."

def norm_rules(code, raw, questions):
    spec = SPEC[code]
    rules = []
    for r in raw:
        rid = r["id"]
        d = r.get("due") or r.get("dueRule")
        due, dtext = due_from(code, rid, d, r)
        if due["kind"] == "relative" and not dtext:
            dtext = rel_text(due)
        meaning = r.get("plain") or r.get("whatThisUsuallyMeans") or r.get("plainMeaning") or r.get("what")
        rule = {
            "id": rid,
            "country": code,
            "area": AREA[r["area"]],
            "title": title_fix(r["title"]),
            "meaning": clean(meaning),
            "when": cond_from(code, rid, r.get("appliesWhen")),
            "due": due,
            "dueText": sentence(dtext),
            "authority": clean(r["authority"]),
            "consequence": clean(r.get("consequence") or r.get("consequenceIfMissed")),
            "sources": r.get("sources") or r.get("sourceUrls") or [],
            "confidence": r["confidence"],
            "notes": clean(r.get("notes")),
            "reviewedByCounsel": False,
        }
        if rid in spec["roll"]:
            rule["rollWeekend"] = spec["roll"][rid]
        if rid in spec["estimated"]:
            rule["estimatedFromYear"] = spec["estimated"][rid]
        rules.append(rule)
    # "!" values (Spain "residencyStatus!=visitor") become every other option value.
    vals = possible_values(questions)
    for rule in rules:
        groups = [rule["when"]["all"]] + rule["when"].get("anyOf", [])
        for g in groups:
            for k, v in list(g.items()):
                if any(x.startswith("!") for x in v):
                    excl = {x[1:] for x in v}
                    g[k] = sorted(x for x in vals.get(k, set()) if x not in excl)
    return rules

def possible_values(questions):
    vals = {}
    for qd in questions:
        if qd["type"] == "date":
            vals.setdefault(qd["key"], set()).add("<date>")
            if qd.get("dateAs"):
                for t in qd["dateAs"]["map"].values():
                    vals.setdefault(t, set()).add("<date>")
        for o in qd["options"]:
            vals.setdefault(qd["key"], set()).add(o["value"])
            for k, v in (o.get("sets") or {}).items():
                for x in (v if isinstance(v, list) else [v]):
                    vals.setdefault(k, set()).add(x)
    return vals

def validate(code, questions, rules):
    errs = []
    vals = possible_values(questions)
    keys = [qd["key"] for qd in questions]
    if len(keys) != len(set(keys)):
        errs.append(f"{code}: duplicate question keys")
    ids = {r["id"] for r in rules}
    for r in rules:
        w = r["when"]
        for g in [w["all"]] + w.get("anyOf", []) + ([w["unless"]] if w.get("unless") else []):
            for k, v in g.items():
                if k not in vals:
                    errs.append(f"{r['id']}: condition key {k} has no question")
                    continue
                for x in v:
                    if x not in vals[k]:
                        errs.append(f"{r['id']}: {k}={x} is not a possible answer {sorted(vals[k])}")
        if not r["title"].endswith("may require review"):
            errs.append(f"{r['id']}: title")
        if r["due"]["kind"] == "sameAs" and r["due"]["ruleId"] not in ids:
            errs.append(f"{r['id']}: sameAs unknown")
        if not r["sources"] and r["confidence"] != "low":
            errs.append(f"{r['id']}: no sources (only low-confidence items may lack them)")
    return errs

HEADER = '''/**
 * API/countries/rules/{file}.ts: {name} ({code}). GENERATED, do not edit by hand.
 * Source: docs/research/{src}.md (research date {date}), imported by
 * scripts/importCountryResearch.py. {n} rules ({low} low confidence), {nq} questions.
 * Every rule has reviewedByCounsel: false until a {name} partner lawyer signs it off.
 */
import type {{ CountryRuleset }} from "./engine.ts";

export const {const}: CountryRuleset = '''

NAMES = {"CO": "Colombia", "CR": "Costa Rica", "PA": "Panama", "MX": "Mexico", "ES": "Spain", "PT": "Portugal"}

def main():
    check_only = "--check" in sys.argv
    all_errs = []
    summary = []
    for code in FILES:
        rawo, rawq, date = research(code)
        questions = norm_questions(code, rawq)
        rules = norm_rules(code, rawo, questions)
        errs = validate(code, questions, rules)
        all_errs += errs
        low = [r["id"] for r in rules if r["confidence"] == "low"]
        summary.append((code, len(rules), len(low), len(questions)))
        if check_only:
            continue
        data = {"country": code, "researchDate": date, "questions": questions, "rules": rules}
        body = json.dumps(data, ensure_ascii=False, indent=2)
        head = HEADER.format(file=code.lower(), name=NAMES[code], code=code, src=FILES[code], date=date, n=len(rules), low=len(low),
                             nq=len(questions), const=code + "_RULESET")
        with open(os.path.join(OUT, code.lower() + ".ts"), "w", encoding="utf-8") as f:
            f.write(head + body + ";\n")
    for s in summary:
        print("%s: %d rules, %d low confidence, %d questions" % s)
    if all_errs:
        print("\n".join(all_errs))
        raise SystemExit(1)

if __name__ == "__main__":
    main()
