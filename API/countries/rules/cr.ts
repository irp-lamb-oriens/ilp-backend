/**
 * API/countries/rules/cr.ts: Costa Rica (CR). GENERATED, do not edit by hand.
 * Source: docs/research/costa-rica.md (research date 2026-10-27), imported by
 * scripts/importCountryResearch.py. 35 rules (6 low confidence), 20 questions.
 * Every rule has reviewedByCounsel: false until a Costa Rica partner lawyer signs it off.
 */
import type { CountryRuleset } from "./engine.ts";

export const CR_RULESET: CountryRuleset = {
  "country": "CR",
  "researchDate": "2026-10-27",
  "questions": [
    {
      "key": "residencyStatus",
      "stage": "check",
      "question": "What is your current immigration status in Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "none",
          "label": "Visitor / no residency"
        },
        {
          "value": "pending",
          "label": "Residency application in process"
        },
        {
          "value": "temporary",
          "label": "Temporary resident (pensionado, rentista, inversionista, other)"
        },
        {
          "value": "permanent",
          "label": "Permanent resident"
        },
        {
          "value": "digital_nomad",
          "label": "Digital nomad (remote worker stay)"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Residency rules set renewal dates and how long you can stay."
    },
    {
      "key": "residencyCategory",
      "stage": "check",
      "question": "Which residency category do you hold?",
      "type": "choice",
      "options": [
        {
          "value": "pensionado",
          "label": "Pensionado (retiree)"
        },
        {
          "value": "rentista",
          "label": "Rentista (fixed income)"
        },
        {
          "value": "inversionista",
          "label": "Inversionista (investor)"
        },
        {
          "value": "vinculo",
          "label": "Family tie (vínculo)"
        },
        {
          "value": "other",
          "label": "Other / not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Each residency category has its own conditions to keep.",
      "showIf": {
        "residencyStatus": [
          "temporary",
          "pending"
        ]
      }
    },
    {
      "key": "residencyExpiryDate",
      "stage": "check",
      "question": "When does your DIMEX card (or digital nomad stay) expire?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "research",
      "showIf": {
        "residencyStatus": [
          "temporary",
          "permanent",
          "digital_nomad"
        ]
      },
      "why": "Renewals are dated from it.",
      "help": "It is printed on the card. Skip this if you do not have it at hand."
    },
    {
      "key": "ownsProperty",
      "stage": "check",
      "question": "Do you own a home or land in Costa Rica (in your name or through a company)?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Property owners usually pay local property tax and have a few yearly dates."
    },
    {
      "key": "propertyDetails",
      "stage": "check",
      "question": "Which of these describe your property? (select all)",
      "type": "multi",
      "options": [
        {
          "value": "held_by_company",
          "label": "Held through a company (S.A. or S.R.L.)",
          "sets": {
            "propertyHeldByCompany": "yes"
          }
        },
        {
          "value": "luxury_over_threshold",
          "label": "Construction value may exceed ¢143 million (roughly US$280,000)",
          "sets": {
            "luxuryThreshold": "yes"
          }
        },
        {
          "value": "maritime_concession",
          "label": "Beachfront concession in the maritime zone",
          "sets": {
            "maritimeZoneConcession": "yes"
          }
        },
        {
          "value": "unsure",
          "label": "Not sure",
          "sets": {
            "luxuryThreshold": "unsure"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Some property situations add a tax or a concession fee.",
      "showIf": {
        "ownsProperty": [
          "yes"
        ]
      }
    },
    {
      "key": "hasCompany",
      "stage": "check",
      "question": "Do you own or control a Costa Rican company?",
      "type": "choice",
      "options": [
        {
          "value": "active",
          "label": "Yes, it runs a business or rents property",
          "sets": {
            "hasCompany": "yes",
            "companyActivity": "active"
          }
        },
        {
          "value": "inactive",
          "label": "Yes, it only holds an asset or is dormant",
          "sets": {
            "hasCompany": "yes",
            "companyActivity": "inactive"
          }
        },
        {
          "value": "unsure",
          "label": "Yes, not sure of its tax status",
          "sets": {
            "hasCompany": "yes",
            "companyActivity": "unsure"
          }
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Companies have yearly filings, even when they do no business."
    },
    {
      "key": "rentsProperty",
      "stage": "check",
      "question": "Do you rent out property in Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "long_term",
          "label": "Long-term tenants"
        },
        {
          "value": "short_term",
          "label": "Short-term / vacation rentals (Airbnb, VRBO)"
        },
        {
          "value": "both",
          "label": "Both"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Rental income usually has its own tax returns."
    },
    {
      "key": "ownsVehicle",
      "stage": "check",
      "question": "Do you own a vehicle with Costa Rican plates? If so, what is the last digit of the plate?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No vehicle"
        },
        {
          "value": "1",
          "label": "Yes, plate ends in 1",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "1"
          }
        },
        {
          "value": "2",
          "label": "Yes, plate ends in 2",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "2"
          }
        },
        {
          "value": "3",
          "label": "Yes, plate ends in 3",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "3"
          }
        },
        {
          "value": "4",
          "label": "Yes, plate ends in 4",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "4"
          }
        },
        {
          "value": "5",
          "label": "Yes, plate ends in 5",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "5"
          }
        },
        {
          "value": "6",
          "label": "Yes, plate ends in 6",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "6"
          }
        },
        {
          "value": "7",
          "label": "Yes, plate ends in 7",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "7"
          }
        },
        {
          "value": "8",
          "label": "Yes, plate ends in 8",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "8"
          }
        },
        {
          "value": "9",
          "label": "Yes, plate ends in 9",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "9"
          }
        },
        {
          "value": "0",
          "label": "Yes, plate ends in 0",
          "sets": {
            "ownsVehicle": "yes",
            "plateLastDigit": "0"
          }
        },
        {
          "value": "yes",
          "label": "Yes, but I do not know the last digit of the plate"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Vehicles have yearly fees, inspections and insurance dates."
    },
    {
      "key": "hasEmployees",
      "stage": "check",
      "question": "Do you employ anyone in Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "domestic",
          "label": "Household staff (housekeeper, gardener, caretaker, nanny)"
        },
        {
          "value": "business",
          "label": "Business employees"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Employers, including households with staff, have monthly payments and yearly bonuses."
    },
    {
      "key": "hasLocalWill",
      "stage": "check",
      "question": "Do you have a Costa Rican will covering your local assets?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "unsure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "residencyExpired",
      "stage": "profile",
      "question": "Has your DIMEX or stay already expired?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "temporary",
          "permanent",
          "digital_nomad"
        ]
      }
    },
    {
      "key": "drivesInCountry",
      "stage": "profile",
      "question": "Do you drive in Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "propertyUse",
      "stage": "profile",
      "question": "How do you use the property?",
      "type": "choice",
      "options": [
        {
          "value": "residence",
          "label": "I live in it"
        },
        {
          "value": "vacation_home",
          "label": "Vacation home"
        },
        {
          "value": "rental",
          "label": "I rent it out"
        },
        {
          "value": "other",
          "label": "Land or other use"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "ownsProperty": [
          "yes"
        ]
      }
    },
    {
      "key": "companyType",
      "stage": "profile",
      "question": "What kind of company is it?",
      "type": "choice",
      "options": [
        {
          "value": "SA",
          "label": "Sociedad anónima (S.A.)"
        },
        {
          "value": "SRL",
          "label": "Limitada (S.R.L.)"
        },
        {
          "value": "unsure",
          "label": "I am not sure"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "hasCompany": [
          "active",
          "inactive",
          "unsure"
        ]
      }
    },
    {
      "key": "companyCreatedThisYear",
      "stage": "profile",
      "question": "Was the company registered this year?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "hasCompany": [
          "active",
          "inactive",
          "unsure"
        ]
      }
    },
    {
      "key": "hasLocalBusinessIncome",
      "stage": "profile",
      "question": "Do you earn business or self-employment income in Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "unsure",
          "label": "I am not sure"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "rentAboveVatThreshold",
      "stage": "profile",
      "question": "Is the monthly rent above about ₡693,000 (1.5 base salaries)?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "unsure",
          "label": "I am not sure"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "rentsProperty": [
          "long_term",
          "both"
        ]
      }
    },
    {
      "key": "planningImport",
      "stage": "profile",
      "question": "Are you planning to bring a vehicle or household goods into Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "spouseIsCostaRican",
      "stage": "profile",
      "question": "Is your spouse Costa Rican?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "marriedAbroad",
      "stage": "profile",
      "question": "Did you marry outside Costa Rica?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "spouseIsCostaRican": [
          "yes"
        ]
      }
    }
  ],
  "rules": [
    {
      "id": "CR_IMM_TEMP_RENEWAL",
      "country": "CR",
      "area": "immigration",
      "title": "Temporary residency and DIMEX renewal may require review",
      "meaning": "Temporary residents (pensionado, rentista, inversionista and similar) renew both their residency and their DIMEX card before it expires, showing they still meet the income or investment condition and are up to date with the CCSS.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyExpiryDate",
        "days": -90,
        "windowStartDays": -120
      },
      "dueText": "Renewal can usually be started up to about 3 months before the expiry date on your DIMEX.",
      "authority": "Dirección General de Migración y Extranjería (DGME)",
      "consequence": "Late renewal carries a monthly surcharge; after a lapse some temporary holders may have to re-apply in their category; travel and banking problems while expired.",
      "sources": [
        "https://www.stampednomad.com/updates/costa-rica-cuts-dimex-backlog-85-with-simplified-residence-rules",
        "https://aglegal.com/dimex-renewal/",
        "https://costaricalaw.com/costa-rica-legal-topics/immigration-and-residency/how-to-renew-your-temporary-residency-in-costa-rica/"
      ],
      "confidence": "medium",
      "notes": "Official DGME pages (migracion.go.cr/dimex) were blocked from this environment, so timing comes from law-firm summaries of DGME resolutions. Temporary resolution DJUR-0045-02-2026 (16 Feb 2026 to 16 Feb 2027) cuts DIMEX requirements to CCSS proof, payment proof and a consent form. Pensionados and rentistas must show continued qualifying income (US$1,000/month pension; US$2,500/month rentista, per Ley 9996); inversionistas show the investment is maintained. Commonly cited 2-year term for temporary residency was not confirmed on an opened official page.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_IMM_PERM_DIMEX_RENEWAL",
      "country": "CR",
      "area": "immigration",
      "title": "Permanent resident DIMEX card renewal may require review",
      "meaning": "Permanent residents keep their status but must renew the DIMEX card itself before it expires, with proof of active CCSS coverage and the fee.",
      "when": {
        "all": {
          "residencyStatus": [
            "permanent"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyExpiryDate",
        "days": -90,
        "windowStartDays": -120
      },
      "dueText": "Up to about 3 months before the card expires.",
      "authority": "DGME (appointments also through Banco de Costa Rica / Correos de Costa Rica)",
      "consequence": "DGME guidance cited by a law firm lists a fine of US$3 per month or fraction for permanent residents renewing late; an expired card causes problems with banks, CCSS and re-entry.",
      "sources": [
        "https://crie.cr/costa-rica-dimex-renewal-fees/",
        "https://aglegal.com/dimex-renewal/",
        "https://www.stampednomad.com/updates/costa-rica-cuts-dimex-backlog-85-with-simplified-residence-rules"
      ],
      "confidence": "medium",
      "notes": "Card validity length for permanent residents was not confirmed on an opened official page. The US$3/month figure is from a law-firm summary of DGME guidance.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_IMM_LATE_RENEWAL_WINDOW",
      "country": "CR",
      "area": "immigration",
      "title": "Expired residency grace window may require review",
      "meaning": "If a DIMEX or residency has already expired, there is a limited window after expiry in which renewal can still be filed; after it, some categories may lose status.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary",
            "permanent",
            "digital_nomad"
          ],
          "residencyExpired": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyExpiryDate",
        "days": 0
      },
      "dueText": "From the expiry date. Sources disagree on how long the late window lasts (3 or 6 months), so act right away.",
      "authority": "DGME",
      "consequence": "For temporary/special categories, legal stay may end automatically once the post-expiry window passes; fines for months elapsed.",
      "sources": [
        "https://crie.cr/?p=295371",
        "https://morimor.com/es/nuevos-plazos-para-la-presentacion-de-prorrogas-de-permisos-de-residencias-temporales-provisionales-o-del-permiso-de-residencia-permanente-y-visa-de-trabajadores-domesticas"
      ],
      "confidence": "low",
      "notes": "Sources conflict (3 vs 6 months) and neither is the official text. Treat as 'act immediately and call a lawyer' rather than a computed date.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_IMM_CCSS_CONTRIBUTIONS",
      "country": "CR",
      "area": "immigration",
      "title": "Monthly CCSS (Caja) payment may require review",
      "meaning": "Legal residents must be enrolled in the national health system (CCSS), usually as voluntary insured or through an employer, and keep monthly payments current; proof is required at every DIMEX renewal.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary",
            "permanent"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": null
      },
      "dueText": "Ongoing monthly payment; check status before each renewal and before travel.",
      "authority": "Caja Costarricense de Seguro Social (CCSS); enforced via DGME",
      "consequence": "Renewal cannot proceed without CCSS proof; a 2020 decree reform stated that failing to pay CCSS could lead to loss of resident status; arrears accrue.",
      "sources": [
        "https://crie.cr/?p=295869",
        "https://aglegal.com/dimex-renewal/",
        "https://elmundo.cr/costa-rica/residentes-sin-seguro-vigente-con-la-ccss-podran-ingresar-al-pais-bajo-condicion-de-ponerse-al-dia/"
      ],
      "confidence": "medium",
      "notes": "CCSS website blocked automated fetching (robots). Digital nomads (estancia) are not in the CCSS system; they need private insurance instead. The loss-of-status statement comes from a 2020 COVID-era decree article.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_IMM_NOMAD_STAY_EXPIRY",
      "country": "CR",
      "area": "immigration",
      "title": "Digital nomad stay expiry or extension may require review",
      "meaning": "The remote-worker (digital nomad) stay is granted for one year with an option to renew, so the end date needs a decision: extend, change category or leave.",
      "when": {
        "all": {
          "residencyStatus": [
            "digital_nomad"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyExpiryDate",
        "days": -60
      },
      "dueText": "60 days before the stay ends, to decide whether to extend, change category or leave.",
      "authority": "DGME (Ley 10008 and regulation)",
      "consequence": "Overstaying after the authorized period makes the person irregular; loss of the income-tax exemption tied to the category.",
      "sources": [
        "https://observador.cr/requisitos-para-ser-nomada-digital-en-costa-rica-ingresos-por-3-000-y-pago-de-190/",
        "https://consortiumlegal.com/en/2022/07/11/regulation-of-law-10008-law-to-attract-international-remote-workers-and-service-providers-in-costa-rica/"
      ],
      "confidence": "medium",
      "notes": "Income threshold US$3,000/month (US$4,000 with family) and US$50,000 medical insurance per 2022 articles. Length of the renewal period was not stated in opened sources (commonly reported as one additional year; unverified).",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_IMM_PERMANENT_ELIGIBILITY",
      "country": "CR",
      "area": "immigration",
      "title": "Eligibility to apply for permanent residency may require review",
      "meaning": "After about three years as a temporary resident, many people can apply to switch to permanent residency, which removes the income-proof requirement at renewal.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyStartDate",
        "days": 1095
      },
      "dueText": "Around the 3-year anniversary of temporary residency approval.",
      "authority": "DGME",
      "consequence": "Not a penalty item; missing it simply means continuing to renew as temporary.",
      "sources": [
        "https://crie.cr/legal-residency-options-for-expats-in-costa-rica-2026-crie/"
      ],
      "confidence": "low",
      "notes": "Only a law-firm page confirms the three-year figure; it did not give the exact legal conditions. Opportunity reminder, not a deadline.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_IMM_DRIVER_LICENSE",
      "country": "CR",
      "area": "immigration",
      "title": "Switching to a Costa Rican driver's licence may require review",
      "meaning": "Visitors can drive on a valid foreign licence during their authorized stay; once someone holds a DIMEX they can homologate it into a Costa Rican licence, which residents generally need to drive legally.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary",
            "permanent",
            "digital_nomad"
          ],
          "drivesInCountry": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Once, after the DIMEX is issued; then on the Costa Rican licence's own expiry (first licence is a 3-year 'novato' licence).",
      "authority": "Consejo de Seguridad Vial (COSEVI) / MOPT",
      "consequence": "Driving fines and insurance problems if driving on an invalid licence.",
      "sources": [
        "https://delfino.cr/2024/08/extranjeros-no-tendran-que-esperar-91-dias-para-homologar-su-licencia-de-conducir"
      ],
      "confidence": "medium",
      "notes": "Source is from August 2024 and states homologation is allowed as soon as the DIMEX is issued; it does not set a hard deadline for residents.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_PROP_MUNICIPAL_TAX",
      "country": "CR",
      "area": "property",
      "title": "Municipal property tax (bienes inmuebles) installment may require review",
      "meaning": "Every titled property pays an annual 0.25% tax on its registered value to the local municipality, usually in quarterly installments, often with a discount for paying the year upfront in January-March.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            3,
            31
          ],
          [
            6,
            30
          ],
          [
            9,
            30
          ],
          [
            12,
            31
          ]
        ]
      },
      "dueText": "Quarterly is the common pattern; each municipality sets its own schedule (some collect annually or semi-annually).",
      "authority": "Municipality where the property is located (Ley 7509)",
      "consequence": "Interest and surcharges; municipalities can publish delinquent lists and pursue collection; arrears show up at sale.",
      "sources": [
        "https://www.perezzeledon.go.cr/phocadownload/gestion_tributaria/brochure_ISBI.pdf",
        "https://munisc.go.cr/Documentos/Secciones/15/Calendario%20Tributario%202026.pdf",
        "https://www.ecija.com/actualidad-insights/obligaciones-corporativas-y-tributarias-2026-costa-rica/"
      ],
      "confidence": "medium",
      "notes": "Exact quarter-end dates were not printed in the municipal calendars opened; the rate and the quarterly/advance-discount pattern are confirmed. Municipal service fees (garbage, parks) are billed alongside.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_PROP_VALUE_DECLARATION",
      "country": "CR",
      "area": "property",
      "title": "Property value declaration to the municipality may require review",
      "meaning": "Owners must declare their property's value to the municipality at least every five years; if they don't, the municipality can set a value itself.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "lastPropertyValueDeclarationDate",
        "days": 1825
      },
      "dueText": "Every 5 years from the last declaration (or from purchase).",
      "authority": "Municipality (Ley 7509, art. 16)",
      "consequence": "Municipality may value the property ex officio (often higher), and fines can apply.",
      "sources": [
        "https://www.perezzeledon.go.cr/phocadownload/gestion_tributaria/brochure_ISBI.pdf"
      ],
      "confidence": "medium",
      "notes": "Fine amounts not stated in the opened source. Some owners of a single low-value home can request an exemption ('no afectación'); not confirmed in an opened source.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_PROP_LUXURY_HOME_TAX",
      "country": "CR",
      "area": "property",
      "title": "Luxury home tax (impuesto solidario) filing and payment may require review",
      "meaning": "Owners of a residential or vacation home whose construction value exceeds the yearly threshold (¢143,000,000 for 2026) file and pay an annual tax of 0.25% to 0.55%.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyUse": [
            "residence",
            "vacation_home"
          ],
          "luxuryThreshold": [
            "yes",
            "unsure"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          1,
          15
        ]
      },
      "dueText": "File Form D-174 and pay by 15 January each year (2026 period was due 15 Jan 2026).",
      "authority": "Ministerio de Hacienda, Dirección General de Tributación (TRIBU-CR / OVi)",
      "consequence": "Surcharges, interest and fines under the Código de Normas y Procedimientos Tributarios.",
      "sources": [
        "https://www.hacienda.go.cr/docs/Aviso_informativo_vencimiento_Impuesto_Solidario_2026.pdf",
        "https://www.ey.com/es_ce/technical/tax/tax-alerts/costa-rica-impuesto-solidario--tramos-y-monto-exento-actualizados-para-2026"
      ],
      "confidence": "high",
      "notes": "Threshold and brackets are updated yearly by decree (2026: Decreto 45358-H). Applies even if bought during the prior year. Filed in TRIBU-CR since Oct 2025.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_PROP_ZMT_CANON",
      "country": "CR",
      "area": "property",
      "title": "Maritime zone concession fee (canon) may require review",
      "meaning": "Beachfront land within the 200 m maritime zone is not owned outright; it is held as a municipal concession that carries an annual fee.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "maritimeZoneConcession": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Annual; due date set by each coastal municipality.",
      "authority": "Coastal municipality; Instituto Costarricense de Turismo (Ley 6043)",
      "consequence": "Unpaid fees can jeopardize the concession.",
      "sources": [
        "https://www.ecija.com/en/news-and-insights/can-foreigners-really-own-property-in-costa-rica-a-breakdown-of-your-rights/"
      ],
      "confidence": "low",
      "notes": "The opened source covers foreign-ownership limits (foreigners with under 5 years' residency capped at 49% of a concession) and terms of 5-20 years, but not the fee amount, due date or default consequences.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_PROP_ZMT_CONCESSION_RENEWAL",
      "country": "CR",
      "area": "property",
      "title": "Maritime zone concession expiry may require review",
      "meaning": "Concessions run for a fixed term (typically 5-20 years) and must be renewed; ownership-structure changes also need municipal approval.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "maritimeZoneConcession": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "concessionExpiryDate",
        "days": -365
      },
      "dueText": "Start renewal well ahead of the concession end date.",
      "authority": "Coastal municipality; ICT",
      "consequence": "Concession lapses; share transfers breaching foreign-ownership rules can be void.",
      "sources": [
        "https://www.ecija.com/en/news-and-insights/can-foreigners-really-own-property-in-costa-rica-a-breakdown-of-your-rights/"
      ],
      "confidence": "low",
      "notes": "Renewal lead time is a conservative product choice, not a legal deadline.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_CORP_ENTITY_TAX",
      "country": "CR",
      "area": "corporate",
      "title": "Annual corporation tax (impuesto a las personas jurídicas) may require review",
      "meaning": "Every registered company, active or inactive, pays a flat annual tax in January; amounts for 2026 ranged from ¢69,330 (inactive) to ¢231,100.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          1,
          31
        ]
      },
      "dueText": "Due 31 January; moves to the next business day when it falls on a weekend (2026: 2 Feb).",
      "authority": "Ministerio de Hacienda (TRIBU-CR; paid online by IBAN or at BCR/BAC)",
      "consequence": "Interest and late penalty; three consecutive unpaid years lets the Registro Nacional dissolve the company.",
      "sources": [
        "https://delfino.cr/2026/01/sociedades-tienen-hasta-el-2-de-febrero-para-pagar-el-impuesto-a-las-personas-jurdicas",
        "https://www.ecija.com/actualidad-insights/obligaciones-corporativas-y-tributarias-2026-costa-rica/",
        "https://aglegal.com/es/calendario-obligaciones-societarias/"
      ],
      "confidence": "high",
      "notes": "Micro/small companies registered with MEIC and some MAG producers are exempt. Foreigners without a local bank account can authorize a third party to pay.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_CORP_RTBF",
      "country": "CR",
      "area": "corporate",
      "title": "Beneficial ownership declaration (RTBF) may require review",
      "meaning": "Every company and trust, active or inactive, files an annual declaration of its shareholders and ultimate beneficial owners with the Central Bank during April.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          4,
          30
        ],
        "windowStart": [
          4,
          1
        ]
      },
      "dueText": "Ordinary filing during April; deadline 30 April.",
      "authority": "Banco Central de Costa Rica (Central Directo) under Ley 9416; supervised by Hacienda and ICD",
      "consequence": "Fine of 2% of prior-year gross income (min 3, max 100 base salaries; 3 = ¢1,386,600 in 2026); Registro Nacional will not issue certifications or register documents; notaries flag the non-compliance.",
      "sources": [
        "https://www.pwc.com/ia/es/Tax-legal-news/notas-tecnicas/Cuenta-regresiva-para-la-presentacion-del-Registro-de-Transparencia-y-Beneficiarios-Finales.html",
        "https://siemprealdia.co/costa-rica/impuestos/registro-de-transparencia-y-beneficiarios-finales-rtbf/",
        "https://www.ecija.com/actualidad-insights/obligaciones-corporativas-y-tributarias-2026-costa-rica/"
      ],
      "confidence": "high",
      "notes": "Requires the filer's personal digital signature (firma digital). 2026: only the legal representative or a 'poder generalísimo' holder could file; special powers were excluded.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_CORP_RTBF_NEW_ENTITY",
      "country": "CR",
      "area": "corporate",
      "title": "First beneficial ownership filing for a new company may require review",
      "meaning": "A newly registered company must file its first RTBF declaration shortly after it receives its corporate ID number.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyCreatedThisYear": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "companyRegistrationDate",
        "days": 28
      },
      "dueText": "20 business days after registration / assignment of cédula jurídica (about 28 calendar days).",
      "authority": "Banco Central de Costa Rica (Central Directo)",
      "consequence": "Same sanctions as the ordinary RTBF.",
      "sources": [
        "https://siemprealdia.co/costa-rica/impuestos/registro-de-transparencia-y-beneficiarios-finales-rtbf/"
      ],
      "confidence": "medium",
      "notes": "Single secondary source; confirm against Resolución Conjunta DGT-ICD-R-06-2020.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_CORP_INACTIVE_RETURN",
      "country": "CR",
      "area": "corporate",
      "title": "Inactive company informative return (Form 272) may require review",
      "meaning": "Companies with no business activity still file a yearly informative return listing assets, liabilities and equity, even if all zeros.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyActivity": [
            "inactive",
            "unsure"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          4,
          30
        ]
      },
      "dueText": "30 April each year (one source says 31 March).",
      "authority": "Ministerio de Hacienda, DGT (TRIBU-CR Form 272, formerly D-195)",
      "consequence": "Fine under art. 83 CNPT (minimum around 3 base salaries for companies with no income); can block certifications.",
      "sources": [
        "https://siemprealdia.co/costa-rica/impuestos/declaracion-informativa-de-sociedades-inactivas/",
        "https://aglegal.com/es/calendario-obligaciones-societarias/",
        "https://www.ecija.com/actualidad-insights/obligaciones-corporativas-y-tributarias-2026-costa-rica/"
      ],
      "confidence": "medium",
      "notes": "AG Legal and Siempre al Día give 30 April; ECIJA's 2026 summary gives 31 March. Use 31 March as the reminder date and 30 April as the deadline until confirmed with Hacienda.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_CORP_INCOME_TAX_RETURN",
      "country": "CR",
      "area": "corporate",
      "title": "Company annual income tax return (Form 102) may require review",
      "meaning": "Active companies file and pay their profits tax for the prior calendar year by mid-March.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyActivity": [
            "active"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          3,
          15
        ]
      },
      "dueText": "15 March, moved to next business day if a weekend (2026: 16 March).",
      "authority": "Ministerio de Hacienda, DGT (TRIBU-CR Form 102, formerly D-101)",
      "consequence": "Surcharges and interest; if not filed, the following year's corporation tax cannot be calculated and the company is classed as delinquent.",
      "sources": [
        "https://www.nacion.com/economia/impuesto-sobre-las-utilidades-2026-fecha-limite/RADHPSCYPBGTZMEUFHGMSPJMJM/story/",
        "https://siemprealdia.co/costa-rica/impuestos/cambios-en-declaraciones-tributarias-con-tribu-cr/",
        "https://aglegal.com/es/calendario-obligaciones-societarias/"
      ],
      "confidence": "high",
      "notes": "TRIBU-CR replaced ATV on 6 Oct 2025 and split D-101 into forms 101 (individuals), 102 (companies), 103 (public entities).",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_CORP_PARTIAL_PAYMENTS",
      "country": "CR",
      "area": "corporate",
      "title": "Income tax advance payments may require review",
      "meaning": "Taxpayers with business income pay three advance installments of the current year's income tax, each roughly 25% of a base computed from prior years.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "hasCompany": [
              "yes"
            ],
            "companyActivity": [
              "active"
            ]
          },
          {
            "hasLocalBusinessIncome": [
              "yes"
            ]
          }
        ]
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            6,
            30
          ],
          [
            9,
            30
          ],
          [
            12,
            31
          ]
        ]
      },
      "dueText": "Last business day of June, September and December.",
      "authority": "Ministerio de Hacienda, DGT (TRIBU-CR forms 101/102)",
      "consequence": "Interest and late-payment penalties.",
      "sources": [
        "https://siemprealdia.co/costa-rica/impuestos/obligaciones-tributarias-durante-junio/",
        "https://aglegal.com/es/calendario-obligaciones-societarias/"
      ],
      "confidence": "high",
      "notes": "Applies to taxpayers with a prior-year income tax liability; new taxpayers may have no advance due.",
      "reviewedByCounsel": false,
      "rollWeekend": "previous"
    },
    {
      "id": "CR_CORP_EDUCATION_STAMP",
      "country": "CR",
      "area": "corporate",
      "title": "Education and Culture stamp tax (Timbre de Educación y Cultura) may require review",
      "meaning": "Commercial companies registered in the mercantile registry pay a small fixed annual stamp tax based on declared share capital (¢5,000-¢18,000).",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          3,
          31
        ]
      },
      "dueText": "Due by 31 March (2025 period was due 31 March 2026).",
      "authority": "Ministerio de Hacienda (TRIBU-CR OVi; Ley 5923)",
      "consequence": "Surcharges and interest.",
      "sources": [
        "https://siemprealdia.co/costa-rica/impuestos/timbre-fiscal-en-costa-rica/",
        "https://aglegal.com/es/calendario-obligaciones-societarias/",
        "https://www.ecija.com/actualidad-insights/obligaciones-corporativas-y-tributarias-2026-costa-rica/"
      ],
      "confidence": "medium",
      "notes": "ECIJA describes the payment window as February-March. Unclear whether inactive companies with no income-tax filing compute the amount the same way.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_CORP_ANNUAL_MEETING",
      "country": "CR",
      "area": "corporate",
      "title": "Annual shareholders' meeting and legal books may require review",
      "meaning": "An S.A. holds its ordinary shareholders' meeting within three months after the fiscal year closes and records it in the company's legal books (minutes, shareholder registry).",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyType": [
            "SA",
            "unsure"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          3,
          31
        ]
      },
      "dueText": "Within 3 months of a 31 December close.",
      "authority": "Company law (Código de Comercio); books kept by the company / Registro Nacional",
      "consequence": "Outdated books and minutes delay share transfers, sales and probate (for example when a company-held home passes to heirs).",
      "sources": [
        "https://aglegal.com/es/calendario-obligaciones-societarias/",
        "https://aglegal.com/costa-rica-wills-foreigners/"
      ],
      "confidence": "medium",
      "notes": "No penalty amount found. S.R.L. rules differ (quota holders' meetings); the legal-books obligation is ongoing rather than date-bound.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_CORP_NOTICE_EMAIL",
      "country": "CR",
      "area": "corporate",
      "title": "Company notification email registration may require review",
      "meaning": "Every commercial company must register an official email address with the National Registry; a free self-service system (ACE) opened 20 Sept 2026.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "once",
        "dates": [
          "2027-12-03"
        ]
      },
      "dueText": "One-time; registration free until 3 Dec 2027.",
      "authority": "Registro Nacional, Registro de Personas Jurídicas (Ley 10597; Ley 10962)",
      "consequence": "From 4 Dec 2027 the Registry will not record any document for a company without a valid email, and later requests carry fees.",
      "sources": [
        "https://delfino.cr/2026/09/registro-nacional-habilitara-sistema-para-inscribir-gratis-el-correo-electronico-de-sociedades",
        "https://www.rnpdigital.com/noticias/comunicados/2026/18%20CP%20Ampliacion%20plazos%20de%20inscripcion%20Sociedades%20.pdf"
      ],
      "confidence": "high",
      "notes": "Changed twice in 2026: the deadline was extended to 4 Sept 2026 (May 2026 directive DPJ-001-2026), then Ley 10962 set 3 Dec 2027 with free registration. AG Legal's calendar agrees on 3 Dec 2027.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_CORP_FORM_270",
      "country": "CR",
      "area": "corporate",
      "title": "Monthly purchases/sales informative return (Form 270) may require review",
      "meaning": "Active businesses report monthly transactions not backed by electronic invoices; a 2026 transition lets the whole year be filed in January 2027.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyActivity": [
            "active"
          ]
        }
      },
      "due": {
        "kind": "once",
        "dates": [
          "2027-01-25"
        ]
      },
      "dueText": "2026 months may be filed together by 25 Jan 2027; from 2027, monthly by the 25th of the following month.",
      "authority": "Ministerio de Hacienda (TRIBU-CR Form 270, formerly D-151)",
      "consequence": "Fines for late informative returns after the transition.",
      "sources": [
        "https://siemprealdia.co/costa-rica/impuestos/cambios-en-declaraciones-tributarias-con-tribu-cr/",
        "https://aglegal.com/es/calendario-obligaciones-societarias/"
      ],
      "confidence": "medium",
      "notes": "Mostly relevant to operating businesses rather than holding companies; confirm with the member's accountant.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_TAX_PERSONAL_INCOME_RETURN",
      "country": "CR",
      "area": "tax",
      "title": "Personal annual income tax return (Form 101) may require review",
      "meaning": "Individuals with Costa Rican-source business or self-employment income file and pay their annual profits tax for the prior year by mid-March; salaried employees are normally taxed by payroll withholding instead.",
      "when": {
        "all": {
          "hasLocalBusinessIncome": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          3,
          15
        ]
      },
      "dueText": "15 March (next business day if weekend; 2026: 16 March).",
      "authority": "Ministerio de Hacienda, DGT (TRIBU-CR Form 101)",
      "consequence": "Surcharges, interest and fines.",
      "sources": [
        "https://www.nacion.com/economia/impuesto-sobre-las-utilidades-2026-fecha-limite/RADHPSCYPBGTZMEUFHGMSPJMJM/story/",
        "https://siemprealdia.co/costa-rica/impuestos/cambios-en-declaraciones-tributarias-con-tribu-cr/"
      ],
      "confidence": "high",
      "notes": "Costa Rica currently taxes on a territorial basis (local-source income only). Income declared to qualify as pensionado/rentista is exempt under Ley 9996, per ECIJA.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_TAX_RENTAL_INCOME",
      "country": "CR",
      "area": "tax",
      "title": "Monthly rental income tax return may require review",
      "meaning": "People who rent out Costa Rican property usually file a monthly capital-income return and pay 15% on 85% of gross rent (about 12.75%), unless they opt into the business regime.",
      "when": {
        "all": {
          "rentsProperty": [
            "long_term",
            "short_term",
            "both"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": 15
      },
      "dueText": "By the 15th of the following month, including months with no rent.",
      "authority": "Ministerio de Hacienda, DGT (TRIBU-CR forms 116/117/118, formerly D-125)",
      "consequence": "Surcharges, interest and fines for late or missing monthly returns.",
      "sources": [
        "https://siemprealdia.co/costa-rica/impuestos/obligaciones-tributarias-durante-junio/",
        "https://siemprealdia.co/costa-rica/impuestos/cambios-en-declaraciones-tributarias-con-tribu-cr/",
        "https://delfino.cr/2026/03/colegio-de-contadores-publicos-recuerda-que-alquileres-en-airbnb-y-otras-plataformas-deben-cumplir-con-el-pago-del-iva-y-renta"
      ],
      "confidence": "high",
      "notes": "The alternative business regime (annual Form 101 with expense deductions) requires at least one CCSS-registered employee, per the Colegio de Contadores note.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_TAX_VAT_RENTAL",
      "country": "CR",
      "area": "tax",
      "title": "Monthly VAT (IVA) return on rentals may require review",
      "meaning": "Short-term vacation rentals charge 13% VAT, and long-term residential rents above 1.5 base salaries a month are also subject to VAT, so the landlord files a monthly VAT return.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "rentsProperty": [
              "short_term",
              "both"
            ]
          },
          {
            "rentsProperty": [
              "long_term"
            ],
            "rentAboveVatThreshold": [
              "yes",
              "unsure"
            ]
          }
        ]
      },
      "due": {
        "kind": "monthly",
        "day": 15
      },
      "dueText": "By the 15th of the following month, even with no sales.",
      "authority": "Ministerio de Hacienda, DGT (TRIBU-CR Form 150, formerly D-104)",
      "consequence": "Surcharges, interest and fines; uncollected VAT may be assessed on the landlord.",
      "sources": [
        "https://delfino.cr/2026/03/colegio-de-contadores-publicos-recuerda-que-alquileres-en-airbnb-y-otras-plataformas-deben-cumplir-con-el-pago-del-iva-y-renta",
        "https://observador.cr/proyecto-de-ley-busca-exonerar-los-alquileres-de-vivienda-del-pago-de-iva/",
        "https://siemprealdia.co/costa-rica/impuestos/obligaciones-tributarias-durante-junio/"
      ],
      "confidence": "medium",
      "notes": "The 1.5 base-salary residential threshold comes from a 2022 article (about ¢693,000 then); 2026 base salary is ¢462,000, so roughly ¢693,000/month still, but confirm. Short-term hosts register activity code 5510.9 and issue electronic invoices.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "CR_TAX_FOREIGN_INCOME_WATCH",
      "country": "CR",
      "area": "tax",
      "title": "Proposed tax on foreign passive income may require review",
      "meaning": "A September 2026 government bill would start taxing residents on foreign dividends, interest, rents and capital gains at about 15%; it is not law yet but could affect pensionados and rentistas.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary",
            "permanent"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Watch item; no due date until enacted.",
      "authority": "Asamblea Legislativa (expediente 25.796); Ministerio de Hacienda",
      "consequence": "None today; if enacted, unplanned tax on foreign investment income.",
      "sources": [
        "https://delfino.cr/2026/09/reforma-fiscal-para-rentas-extranjeras",
        "https://delfino.cr/2026/10/proyecto-de-ley-n-25796-antes-de-gravar-las-rentas-del-exterior-midamos-todas-las-consecuencias"
      ],
      "confidence": "low",
      "notes": "Bill filed 22 Sept 2026; status, effective date and treatment of pensions not confirmed. Do not present as a current obligation.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_VEH_MARCHAMO",
      "country": "CR",
      "area": "vehicle",
      "title": "Annual vehicle circulation fee (marchamo) may require review",
      "meaning": "Every registered vehicle pays the marchamo each year, which bundles vehicle property tax and mandatory SOA insurance; collection opens in early November.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          12,
          31
        ],
        "windowStart": [
          11,
          1
        ]
      },
      "dueText": "Pay between early November and 31 December for the next year.",
      "authority": "Instituto Nacional de Seguros (INS) collects; MOPT/COSEVI enforce",
      "consequence": "¢60,000 traffic fine and possible plate or vehicle removal; monthly penalties of 10% (capped at 100%) on the property-tax portion plus interest.",
      "sources": [
        "https://www.larepublica.net/noticia/marchamo-costa-rica-2026-todo-lo-que-necesita-saber"
      ],
      "confidence": "high",
      "notes": "Requires a valid RTV for the sticker (marchamo can be paid first and the sticker collected after RTV approval). INS offers no payment plans, per the source.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_VEH_RTV",
      "country": "CR",
      "area": "vehicle",
      "title": "Vehicle technical inspection (RTV) may require review",
      "meaning": "Vehicles must pass the periodic technical inspection run by Dekra; the month is set by the last digit of the plate.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthByAnswer",
        "answer": "plateLastDigit",
        "map": {
          "0": 10,
          "1": 1,
          "2": 2,
          "3": 3,
          "4": 4,
          "5": 5,
          "6": 6,
          "7": 7,
          "8": 8,
          "9": 9
        }
      },
      "dueText": "In the month set by the last digit of the plate (1 is January, 9 is September, 0 is October); plates ending in 1 and 2 may go a month early.",
      "authority": "MOPT / COSEVI; inspections by Dekra",
      "consequence": "Traffic fines and inability to get the marchamo sticker.",
      "sources": [
        "https://delfino.cr/2026/01/66-de-vehiculos-tienen-pendiente-su-inspeccion-tecnica-vehicular-de-enero",
        "https://delfino.cr/2023/03/mopt-anuncia-cambios-en-revision-de-dekra-para-que-vehiculos-ya-no-tengan-que-ir-dos-veces-en-2023"
      ],
      "confidence": "medium",
      "notes": "Mapping for 7-0 and 1 confirmed in news sources; 2-6 inferred from the same pattern. Inspection frequency by vehicle age (annual vs biennial) not confirmed; repeated amnesty decrees in 2022-2024 shifted dates.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_VEH_IMPORT",
      "country": "CR",
      "area": "vehicle",
      "title": "Importing a vehicle or household goods duty-free may require review",
      "meaning": "Pensionados, rentistas and investors under Ley 9996 can request duty exemptions for household goods and up to two vehicles, which must then be kept for a set period.",
      "when": {
        "all": {
          "residencyCategory": [
            "pensionado",
            "rentista",
            "inversionista"
          ],
          "planningImport": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Event-driven: before shipping; exempt goods must be kept (reported as 10 years).",
      "authority": "Ministerio de Hacienda (Exonet); Dirección General de Aduanas",
      "consequence": "Selling exempt goods early can trigger the unpaid duties.",
      "sources": [
        "https://www.ecija.com/actualidad-insights/se-aprueba-nueva-ley-para-atraer-inversionistas-rentistas-y-pensionados-a-costa-rica/",
        "https://www.elfinancierocr.com/economia-y-politica/estas-son-las-nuevas-reglas-para-que/6N33ID3GMBFZJLDMXVKCARKNUE/story"
      ],
      "confidence": "low",
      "notes": "Sources describe the law at passage (2021). Whether the incentive application window is still open in 2026 was not confirmed; standard import duties for others were not researched.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_LAB_CCSS_EMPLOYER",
      "country": "CR",
      "area": "employment",
      "title": "Employer social security (CCSS) payroll may require review",
      "meaning": "Anyone employing staff, including a household worker, registers as an employer with the CCSS and reports and pays contributions every month.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic",
            "business"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": 20
      },
      "dueText": "Payroll report between the 26th and 4th business day of next month; payment between the 16th and 20th per CCSS billing.",
      "authority": "Caja Costarricense de Seguro Social (CCSS)",
      "consequence": "Arrears with surcharges; employer liability for medical costs of an uninsured worker; CCSS debt blocks many state procedures.",
      "sources": [
        "https://aglegal.com/es/calendario-obligaciones-societarias/",
        "https://www.mtss.go.cr/temas-laborales/trabajo%20domestico/trabajo_domestico.html"
      ],
      "confidence": "medium",
      "notes": "Worker deduction cited by MTSS for domestic workers is 10.67%; employer share not captured here. Domestic-worker minimum wage figure on the MTSS page looked outdated, so not reproduced.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_LAB_INS_WORK_RISK",
      "country": "CR",
      "area": "employment",
      "title": "Work-risk insurance (riesgos del trabajo) policy may require review",
      "meaning": "Employers, including households with domestic staff, must hold an INS work-accident policy covering their workers and keep it current.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic",
            "business"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Before the first day of work, then keep active (renewal per policy terms).",
      "authority": "Instituto Nacional de Seguros (INS)",
      "consequence": "Employer pays the full cost of any work accident for uninsured staff, plus fines.",
      "sources": [
        "https://www.mtss.go.cr/temas-laborales/trabajo%20domestico/trabajo_domestico.html"
      ],
      "confidence": "medium",
      "notes": "MTSS says to register with CCSS and Riesgos del Trabajo; policy renewal cycle and reporting dates were not confirmed.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_LAB_AGUINALDO",
      "country": "CR",
      "area": "employment",
      "title": "Year-end bonus (aguinaldo) payment may require review",
      "meaning": "Employers pay every worker a thirteenth-month bonus equal to one-twelfth of all pay earned from 1 December to 30 November.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic",
            "business"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          12,
          20
        ]
      },
      "dueText": "No later than 20 December.",
      "authority": "Ministerio de Trabajo y Seguridad Social (MTSS)",
      "consequence": "Labor inspection complaints from 21 December; MTSS says fines can exceed ¢10 million and cases go to court.",
      "sources": [
        "https://www.mtss.go.cr/prensa/comunicados/2025/noviembre/cp_054_2025.html",
        "https://www.mtss.go.cr/temas-laborales/trabajo%20domestico/trabajo_domestico.html",
        "https://aglegal.com/es/calendario-obligaciones-societarias/"
      ],
      "confidence": "high",
      "notes": "Owed after one continuous month of work; domestic workers are entitled per the MTSS domestic work page.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_LAB_VACATION",
      "country": "CR",
      "area": "employment",
      "title": "Staff paid vacation may require review",
      "meaning": "Workers earn paid vacation each year (domestic workers 15 days per year per MTSS); unused or prorated vacation is paid when employment ends.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic",
            "business"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "employeeStartDate",
        "days": 350,
        "annual": true
      },
      "dueText": "Yearly on each employee's work anniversary (after 50 weeks).",
      "authority": "MTSS (Código de Trabajo)",
      "consequence": "Claims for unpaid vacation at termination; labor inspection.",
      "sources": [
        "https://www.mtss.go.cr/temas-laborales/trabajo%20domestico/trabajo_domestico.html"
      ],
      "confidence": "medium",
      "notes": "General (non-domestic) vacation rule of two weeks per 50 weeks is commonly cited but was not opened here.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_FAM_LOCAL_WILL",
      "country": "CR",
      "area": "estate",
      "title": "Costa Rican will for local assets may require review",
      "meaning": "A separate Spanish-language will signed before a Costa Rican notary, covering only Costa Rican assets, usually makes inheritance of local property or company shares faster than relying on a foreign will.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "ownsProperty": [
              "yes"
            ]
          },
          {
            "hasCompany": [
              "yes"
            ]
          },
          {
            "ownsVehicle": [
              "yes"
            ]
          }
        ]
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Review after marriage, divorce, birth, buying/selling property, moving property into or out of a company, or changing the home-country will.",
      "authority": "Costa Rican notary public; courts (sucesión)",
      "consequence": "Without a local will, intestate rules decide heirs and foreign wills need court recognition (exequátur), adding time and cost.",
      "sources": [
        "https://aglegal.com/costa-rica-wills-foreigners/"
      ],
      "confidence": "medium",
      "notes": "Law-firm source only. Not a deadline; a life-event review trigger.",
      "reviewedByCounsel": false
    },
    {
      "id": "CR_FAM_FOREIGN_MARRIAGE",
      "country": "CR",
      "area": "estate",
      "title": "Registering a foreign marriage in Costa Rica may require review",
      "meaning": "If one spouse is Costa Rican, a marriage celebrated abroad can be recorded in the Costa Rican Civil Registry using an apostilled and translated certificate.",
      "when": {
        "all": {
          "spouseIsCostaRican": [
            "yes"
          ],
          "marriedAbroad": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Event-driven; resolution in about 22 business days after filing.",
      "authority": "Tribunal Supremo de Elecciones, Registro Civil",
      "consequence": "Marriage not reflected in Costa Rican records, which complicates residency by family tie (vínculo), property and inheritance steps.",
      "sources": [
        "https://www.tse.go.cr/pdf/requisitosytramites/Inscripcion-matrimonio-celebrado-en-el-extranjero.pdf"
      ],
      "confidence": "high",
      "notes": "Applies only when one spouse is Costa Rican; for two foreigners, residency by marriage is handled by DGME, not this registry.",
      "reviewedByCounsel": false
    }
  ]
};
