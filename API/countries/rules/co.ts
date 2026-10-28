/**
 * API/countries/rules/co.ts: Colombia (CO). GENERATED, do not edit by hand.
 * Source: docs/research/colombia.md (research date 2026-10-27), imported by
 * scripts/importCountryResearch.py. 49 rules (6 low confidence), 16 questions.
 * Every rule has reviewedByCounsel: false until a Colombia partner lawyer signs it off.
 */
import type { CountryRuleset } from "./engine.ts";

export const CO_RULESET: CountryRuleset = {
  "country": "CO",
  "researchDate": "2026-10-27",
  "questions": [
    {
      "key": "residencyStatus",
      "stage": "check",
      "question": "What is your current status in Colombia?",
      "type": "choice",
      "options": [
        {
          "value": "visitor",
          "label": "Visitor or tourist (no visa, or a short visa)",
          "sets": {
            "livesInColombia": "yes"
          }
        },
        {
          "value": "visa_digital_nomad",
          "label": "Digital nomad visa",
          "sets": {
            "livesInColombia": "yes"
          }
        },
        {
          "value": "visa_V_long",
          "label": "Another visitor (V) visa longer than 3 months",
          "sets": {
            "livesInColombia": "yes"
          }
        },
        {
          "value": "visa_M",
          "label": "Migrant (M) visa, for example pensioner, investor or spouse",
          "sets": {
            "livesInColombia": "yes"
          }
        },
        {
          "value": "visa_R",
          "label": "Resident (R) visa issued since October 2022",
          "sets": {
            "livesInColombia": "yes"
          }
        },
        {
          "value": "visa_R_pre2022",
          "label": "Resident visa issued before October 2022",
          "sets": {
            "livesInColombia": "yes"
          }
        },
        {
          "value": "none",
          "label": "I don't live in Colombia",
          "sets": {
            "livesInColombia": "no"
          }
        },
        {
          "value": "unsure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Residency rules set renewal dates and how long you can stay."
    },
    {
      "key": "visaExpiryWindow",
      "stage": "check",
      "question": "When does your visa or permitted stay end?",
      "type": "choice",
      "options": [
        {
          "value": "lt30",
          "label": "Within 30 days"
        },
        {
          "value": "30to90",
          "label": "In 1 to 3 months"
        },
        {
          "value": "gt90",
          "label": "More than 3 months away"
        },
        {
          "value": "na",
          "label": "Not applicable"
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
      "key": "daysInColombia",
      "stage": "check",
      "question": "In the last 12 months, about how many days have you spent in Colombia?",
      "type": "choice",
      "options": [
        {
          "value": "lt120",
          "label": "Fewer than 120",
          "sets": {
            "isTaxResident": "no"
          }
        },
        {
          "value": "120to183",
          "label": "120 to 183",
          "sets": {
            "isTaxResident": "unsure"
          }
        },
        {
          "value": "gt183",
          "label": "More than 183",
          "sets": {
            "isTaxResident": "yes"
          }
        },
        {
          "value": "unsure",
          "label": "Not sure",
          "sets": {
            "isTaxResident": "unsure"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Spending more than 183 days in a year usually makes you a tax resident."
    },
    {
      "key": "ownsProperty",
      "stage": "check",
      "question": "Do you own a home or land in Colombia?",
      "type": "choice",
      "options": [
        {
          "value": "bogota",
          "label": "Yes, in Bogotá",
          "sets": {
            "ownsProperty": "yes",
            "propertyCity": "bogota"
          }
        },
        {
          "value": "medellin",
          "label": "Yes, in Medellín",
          "sets": {
            "ownsProperty": "yes",
            "propertyCity": "medellin"
          }
        },
        {
          "value": "other",
          "label": "Yes, elsewhere",
          "sets": {
            "ownsProperty": "yes",
            "propertyCity": "other"
          }
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
      "key": "boughtWithForeignFunds",
      "stage": "check",
      "question": "If you own property, did the purchase money come from abroad?",
      "type": "choice",
      "options": [
        {
          "value": "yes_registered",
          "label": "Yes, and it was declared as foreign investment",
          "sets": {
            "boughtWithForeignFunds": "yes"
          }
        },
        {
          "value": "yes_unsure",
          "label": "Yes, but I'm not sure it was registered",
          "sets": {
            "boughtWithForeignFunds": "yes"
          }
        },
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "na",
          "label": "I don't own property"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "rentsProperty",
      "stage": "check",
      "question": "Do you rent out your Colombian property?",
      "type": "choice",
      "options": [
        {
          "value": "short_term",
          "label": "Yes, short-term to tourists (Airbnb or similar)",
          "sets": {
            "rentsProperty": "yes",
            "rentsShortTerm": "yes"
          }
        },
        {
          "value": "long_term",
          "label": "Yes, long-term",
          "sets": {
            "rentsProperty": "yes",
            "rentsShortTerm": "no"
          }
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Rental income usually has its own tax returns."
    },
    {
      "key": "hasCompany",
      "stage": "check",
      "question": "Do you own a Colombian company (such as an S.A.S.) or a registered business?",
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
      "source": "research",
      "why": "Companies have yearly filings, even when they do no business."
    },
    {
      "key": "ownsVehicle",
      "stage": "check",
      "question": "Do you own a car or motorcycle registered in Colombia?",
      "type": "choice",
      "options": [
        {
          "value": "bogota",
          "label": "Yes, registered in Bogotá",
          "sets": {
            "ownsVehicle": "yes",
            "vehicleRegisteredIn": "bogota"
          }
        },
        {
          "value": "antioquia",
          "label": "Yes, registered in Antioquia or Medellín",
          "sets": {
            "ownsVehicle": "yes",
            "vehicleRegisteredIn": "antioquia"
          }
        },
        {
          "value": "other",
          "label": "Yes, elsewhere",
          "sets": {
            "ownsVehicle": "yes",
            "vehicleRegisteredIn": "other"
          }
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Vehicles have yearly fees, inspections and insurance dates."
    },
    {
      "key": "hasEmployees",
      "stage": "check",
      "question": "Do you employ anyone in Colombia, such as a housekeeper, nanny or driver?",
      "type": "choice",
      "options": [
        {
          "value": "yes_colombian",
          "label": "Yes",
          "sets": {
            "hasEmployees": "yes",
            "employsForeigners": "no"
          }
        },
        {
          "value": "yes_foreign",
          "label": "Yes, and at least one is a foreign national",
          "sets": {
            "hasEmployees": "yes",
            "employsForeigners": "yes"
          }
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Employers, including households with staff, have monthly payments and yearly bonuses."
    },
    {
      "key": "hasForeignAssetsOver2000UVT",
      "stage": "check",
      "question": "Are your savings, investments and property outside Colombia worth more than about COP 105 million (roughly US$25,000)?",
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
      "key": "visaExpiryDate",
      "stage": "check",
      "question": "What is the expiry date on your visa?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "visa_digital_nomad",
          "visa_V_long",
          "visa_M",
          "visa_R"
        ]
      },
      "why": "Visa renewals and the cédula renewal are dated from it.",
      "help": "It is on your e-visa. Skip this if you do not have it at hand."
    },
    {
      "key": "entryDate",
      "stage": "check",
      "question": "When did you last enter Colombia?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "visitor"
        ]
      },
      "why": "A visitor stay is counted from the day you enter.",
      "help": "The date of your most recent entry stamp. Skip this if you are not sure."
    },
    {
      "key": "visaBasis",
      "stage": "profile",
      "question": "What is your Migrant (M) visa based on?",
      "type": "choice",
      "options": [
        {
          "value": "investor",
          "label": "An investment, such as property"
        },
        {
          "value": "pensioner",
          "label": "A pension"
        },
        {
          "value": "spouse",
          "label": "A Colombian spouse or partner"
        },
        {
          "value": "other",
          "label": "Something else"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "visa_M"
        ]
      }
    },
    {
      "key": "companyHasForeignShareholder",
      "stage": "profile",
      "question": "Does your Colombian company have a shareholder from outside Colombia?",
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
        "hasCompany": [
          "yes"
        ]
      }
    },
    {
      "key": "hasColombianIncome",
      "stage": "profile",
      "question": "Do you earn income from Colombia, such as rent or local fees?",
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
      "key": "employeeEarnsUpTo2SMMLV",
      "stage": "profile",
      "question": "Does anyone who works for you earn up to two monthly minimum wages?",
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
        "hasEmployees": [
          "yes_colombian",
          "yes_foreign"
        ]
      }
    }
  ],
  "rules": [
    {
      "id": "CO_IMM_VISA_REGISTRATION",
      "country": "CO",
      "area": "immigration",
      "title": "Register your visa and apply for your cédula de extranjería within 15 days: may require review",
      "meaning": "A visa valid for more than three months must be registered with Migración Colombia, and the holder (age 7 and up) must get a cédula de extranjería, within 15 calendar days of arriving or of the visa being issued in Colombia.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_V_long",
            "visa_digital_nomad",
            "visa_M",
            "visa_R"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visaIssueOrEntryDate",
        "days": 15
      },
      "dueText": "15 days after the date your visa was issued or you arrived.",
      "authority": "Migración Colombia (Unidad Administrativa Especial Migración Colombia)",
      "consequence": "Classed as a minor (leve) immigration infraction; fine of 26.31 to 210.50 UVT under Res. 2357 de 2020 as amended by Res. 3770 de 2021.",
      "sources": [
        "https://cancilleria.gov.co/atencion-y-servicio-al-ciudadano/tramites-y-servicios/visa/preguntas-frecuentes",
        "https://www.affirmalegal.com/blog/proceso-sancionatorio-migratorio-en-colombia/"
      ],
      "confidence": "high",
      "notes": "Rule and 15-day term confirmed on Cancillería FAQ. Fine range is from a law firm summary (medium). Some Visitor (V) activities are exempt.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_VISA_RENEWAL",
      "country": "CO",
      "area": "immigration",
      "title": "Visa expiry approaching, apply for the next visa: may require review",
      "meaning": "Colombian visas are not extended; a new visa must be requested before the current one ends, and the Cancillería advises starting one to two months ahead.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_V_long",
            "visa_digital_nomad",
            "visa_M"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visaExpiryDate",
        "days": 0,
        "windowStartDays": -60
      },
      "dueText": "On the date your visa expires.",
      "authority": "Ministerio de Relaciones Exteriores (Cancillería), visa authority",
      "consequence": "Once the visa ends the person is irregular unless a new visa or salvoconducto covers them; for M holders, a gap breaks the continuity needed for R residency.",
      "sources": [
        "https://cancilleria.gov.co/atencion-y-servicio-al-ciudadano/tramites-y-servicios/visa/preguntas-frecuentes",
        "https://www.affirmalegal.com/blog/visa-de-residente-en-colombia-tipo-r/"
      ],
      "confidence": "high",
      "notes": "M visas run up to 3 years (Res. 5477 de 2022 art. 64); V visas vary (digital nomad up to 2 years). Visa decision can take up to 30 calendar days after the study fee is paid.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_CE_RENEWAL",
      "country": "CO",
      "area": "immigration",
      "title": "New visa issued, renew your cédula de extranjería: may require review",
      "meaning": "The cédula de extranjería follows the visa, so each new visa or traspaso needs a new card from Migración Colombia within the same 15-day window.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_V_long",
            "visa_digital_nomad",
            "visa_M",
            "visa_R"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "newVisaIssueDate",
        "days": 15
      },
      "dueText": "15 days after the date your new visa was issued.",
      "authority": "Migración Colombia",
      "consequence": "Not renewing is a leve infraction (26.31 to 210.50 UVT); an outdated CE can block banking, notarial and tax procedures.",
      "sources": [
        "https://cancilleria.gov.co/atencion-y-servicio-al-ciudadano/tramites-y-servicios/visa/preguntas-frecuentes",
        "https://www.affirmalegal.com/blog/proceso-sancionatorio-migratorio-en-colombia/"
      ],
      "confidence": "medium",
      "notes": "Fee cited by Affirma Legal at about COP 294,000 under Res. 0599 de 2026 (not opened).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_RESIDENT_TRASPASO_2026",
      "country": "CO",
      "area": "immigration",
      "title": "Older resident visa: traspaso deadline 31 October 2026, may require review",
      "meaning": "People holding a resident visa granted under the rules before Resolución 5477 de 2022 must transfer it to the current format before 31 October 2026, or they cannot get a new cédula de extranjería.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_R_pre2022"
          ]
        }
      },
      "due": {
        "kind": "once",
        "dates": [
          "2026-10-31"
        ]
      },
      "dueText": "Before October 31, 2026. No further extension had been published by the research date.",
      "authority": "Cancillería (visa authority)",
      "consequence": "The traspaso is required to issue the cédula de extranjería; what else happens after the deadline has not been published (possible loss of visa, fine plus salvoconducto, or another extension).",
      "sources": [
        "https://cancilleria.gov.co/normograma/compilacion/docs/resolucion_minrelaciones_9316_2024.htm",
        "https://cancilleria.gov.co/sala-de-prensa/noticias/cancilleria-fija-plazo-hasta-octubre-de-2026-para-traspaso-obligatorio-de-visa-para-extranjeros-residentes-en-colombia",
        "https://www.asuntoslegales.com.co/analisis/rodrigo-tannus-serrano-510256/la-incertidumbre-tiene-fecha-4497884"
      ],
      "confidence": "high",
      "notes": "Deadline is high confidence. Consequence after the deadline is low confidence. Four days from research date: ILP should contact any member with an older R visa now. One-off item, not recurring.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_R_VISA_5YR",
      "country": "CO",
      "area": "immigration",
      "title": "Resident (R) visa 5-year term ending, traspaso needed: may require review",
      "meaning": "An R visa under current rules allows indefinite residence, but the visa document has a formal 5-year term and must be transferred (traspaso) when it ends.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_R"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visaExpiryDate",
        "days": 0,
        "windowStartDays": -60
      },
      "dueText": "On the date your visa expires.",
      "authority": "Cancillería",
      "consequence": "Not completing the traspaso on time is listed as a ground for the visa to lose validity; also blocks CE renewal.",
      "sources": [
        "https://www.affirmalegal.com/blog/visa-de-residente-en-colombia-tipo-r/"
      ],
      "confidence": "medium",
      "notes": "Based on a law firm reading of Res. 5477 de 2022 arts. 88-93; the official text could not be read past art. 71 (online copies truncated).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_R_ABSENCE",
      "country": "CO",
      "area": "immigration",
      "title": "Resident (R) visa: long absence from Colombia, may require review",
      "meaning": "An R visa lapses automatically if the holder stays outside Colombia for more than two continuous years.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_R",
            "visa_R_pre2022"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "lastExitDate",
        "years": 2,
        "windowStartDays": 640
      },
      "dueText": "After more than 2 continuous years outside Colombia, counted from the day you last left.",
      "authority": "Cancillería",
      "consequence": "Visa lapses by operation of law; the person would need a new visa.",
      "sources": [
        "https://www.affirmalegal.com/blog/visa-de-residente-en-colombia-tipo-r/",
        "https://colombiamove.com/blog/colombia-visa-guide-2026-every-visa-type-requirements-how-to-apply/"
      ],
      "confidence": "medium",
      "notes": "Res. 5477 de 2022 art. 93 per Affirma Legal; official article not opened.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_M_ABSENCE",
      "country": "CO",
      "area": "immigration",
      "title": "Migrant (M) visa: more than 180 days away, may require review",
      "meaning": "An M visa loses validity if the holder is outside Colombia for more than 180 continuous days within any 365-day period from issue.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_M"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "lastExitDate",
        "days": 180,
        "windowStartDays": 150
      },
      "dueText": "After more than 180 continuous days outside Colombia in any 365.",
      "authority": "Cancillería",
      "consequence": "Visa lapses by operation of law; continuity toward R residency is lost.",
      "sources": [
        "https://www.affirmalegal.com/blog/como-solicitar-una-visa-de-inversionista-en-colombia/"
      ],
      "confidence": "medium",
      "notes": "Res. 5477 de 2022 art. 65 per Affirma Legal; official article not opened.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_M_TO_R",
      "country": "CO",
      "area": "immigration",
      "title": "Eligible to apply for resident (R) visa: may require review",
      "meaning": "After 5 continuous years on most M visas (3 years for the spouse of a Colombian; 2 for a parent of a Colombian), the holder can apply for an R visa, provided each M visa was granted before the previous one expired.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_M"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "firstMVisaIssueDate",
        "years": 5
      },
      "dueText": "About 5 years after your first M visa (3 years for spouses of Colombians, 2 for parents of Colombians).",
      "authority": "Cancillería",
      "consequence": "Missing it is not penalized, but letting an M lapse resets the count.",
      "sources": [
        "https://www.affirmalegal.com/blog/visa-de-residente-en-colombia-tipo-r/",
        "https://colombiamove.com/blog/colombia-visa-guide-2026-every-visa-type-requirements-how-to-apply/"
      ],
      "confidence": "medium",
      "notes": "Sources differ on spouse time (Colombia Move says 2 years, Affirma Legal 3 years citing art. 90); stored as 3 pending confirmation. Salvoconducto time does not count. Sources also disagree on whether an R visa can be obtained directly by investment (650 SMMLV): treat as unconfirmed (low).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_DIGITAL_NOMAD_END",
      "country": "CO",
      "area": "immigration",
      "title": "Digital nomad visa ending: may require review",
      "meaning": "The digital nomad (V) visa lasts up to two years and requires income of at least 3 SMMLV; at the end the holder needs a different visa or must leave.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_digital_nomad"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visaExpiryDate",
        "days": 0,
        "windowStartDays": -90
      },
      "dueText": "On the date your visa expires.",
      "authority": "Cancillería",
      "consequence": "Staying after expiry without a new visa is an irregular stay.",
      "sources": [
        "https://cancilleria.gov.co/sites/default/files/Normograma/docs/resolucion_minrelaciones_5477_2022.htm",
        "https://colombiamove.com/blog/colombia-visa-guide-2026-every-visa-type-requirements-how-to-apply/"
      ],
      "confidence": "medium",
      "notes": "Validity and 3 SMMLV income confirmed in Res. 5477 (arts. 32 and 46). 'Not renewable, does not count toward R' is from a secondary source (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_VISITOR_STAY",
      "country": "CO",
      "area": "immigration",
      "title": "Visitor stay limit approaching: may require review",
      "meaning": "US and Canadian visitors usually get 90 days on entry, which can be extended once for up to 90 more, but not beyond 180 days in total in the period that applies.",
      "when": {
        "all": {
          "residencyStatus": [
            "visitor"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "entryDate",
        "days": 90
      },
      "dueText": "90 days after you enter, extendable up to 180 days a year.",
      "authority": "Migración Colombia",
      "consequence": "Overstay leads to a sanction process: a fine, or deportation with an entry ban of 6 months to 10 years in serious cases.",
      "sources": [
        "https://nexo.legal/es/overstaying-in-colombia-fines/",
        "https://colombiamove.com/blog/colombia-visa-guide-2026-every-visa-type-requirements-how-to-apply/",
        "https://www.affirmalegal.com/blog/proceso-sancionatorio-migratorio-en-colombia/"
      ],
      "confidence": "medium",
      "notes": "Secondary sources say 180 days per calendar year; Res. 5477 art. 34 (V tourist visa) says 180 days in any 365 days. Official Migración page for visa-exempt visitors not opened. Extension must be requested before the 90 days end.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_INVESTOR_CHANGE",
      "country": "CO",
      "area": "immigration",
      "title": "Selling the property or investment behind your visa: may require review",
      "meaning": "An M investor visa depends on keeping the registered investment; selling the property or withdrawing the capital must be reported to the visa authority.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_M"
          ],
          "visaBasis": [
            "investor"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "investment sold or reduced"
      },
      "dueText": "When it happens: investment sold or reduced.",
      "authority": "Cancillería",
      "consequence": "The visa may be cancelled; renewals are assessed against the minimum wage in force on the filing date (350 SMMLV for real estate in 2026, about COP 612.8 million).",
      "sources": [
        "https://www.affirmalegal.com/blog/como-solicitar-una-visa-de-inversionista-en-colombia/"
      ],
      "confidence": "medium",
      "notes": "Amounts per Affirma Legal citing Res. 5477 arts. 75 and 79. Pensioner visa: 3 SMMLV monthly lifetime pension (about COP 5,252,715 in 2026).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_ADDRESS_CHANGE",
      "country": "CO",
      "area": "immigration",
      "title": "Moved home, update your address with Migración Colombia: may require review",
      "meaning": "Foreigners with a cédula de extranjería must keep their residence details current with Migración Colombia.",
      "when": {
        "all": {
          "residencyStatus": [
            "visa_V_long",
            "visa_digital_nomad",
            "visa_M",
            "visa_R",
            "visa_R_pre2022"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "address changed"
      },
      "dueText": "When it happens: address changed.",
      "authority": "Migración Colombia",
      "consequence": "Leve infraction; fine of 26.31 to 210.50 UVT.",
      "sources": [
        "https://www.affirmalegal.com/blog/proceso-sancionatorio-migratorio-en-colombia/"
      ],
      "confidence": "low",
      "notes": "Obligation and fine range from a law firm summary; the exact reporting term was not found in an official source.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_IMM_SIRE_REPORT",
      "country": "CO",
      "area": "immigration",
      "title": "Hired or let go a foreign worker, report in SIRE: may require review",
      "meaning": "Anyone who hires a foreigner (including domestic staff) or hosts foreigners commercially must report the start and end of the relationship in Migración Colombia's SIRE system within 15 calendar days.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ],
          "employsForeigners": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "employmentStartOrEndDate",
        "days": 15
      },
      "dueText": "15 days after the date the job started or ended.",
      "authority": "Migración Colombia (SIRE)",
      "consequence": "Fines of 105.25 to 2,631.30 UVT after an administrative process.",
      "sources": [
        "https://www.migracioncolombia.gov.co/fileadmin/user_upload/126422_abc-sire.pdf"
      ],
      "confidence": "high",
      "notes": "Res. 2357 de 2020 and Res. 3770 de 2021. Short-term rental hosts are also expected to report guests 'de forma oportuna' (no fixed day count in the ABC).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_PREDIAL_BOGOTA",
      "country": "CO",
      "area": "property",
      "title": "Bogotá property tax (predial), early-payment discount date: may require review",
      "meaning": "Bogotá bills predial once a year; paying in full by the discount date saves 10%, otherwise pay by the final deadline or join the four-installment plan (SPAC).",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyCity": [
            "bogota"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            4,
            17
          ],
          [
            7,
            10
          ]
        ]
      },
      "dueText": "Early-payment discount until April 17, final date July 10 (2026 calendar). Installment plans have their own dates.",
      "authority": "Secretaría Distrital de Hacienda de Bogotá",
      "consequence": "Late payment accrues moratorium interest and penalties; unpaid predial blocks a sale (paz y salvo needed at the notary).",
      "sources": [
        "https://bogota.gov.co/mi-ciudad/hacienda/pago-de-impuestos-en-bogota-conoce-el-calendario-el-tributario-2026"
      ],
      "confidence": "high",
      "notes": "Dates change every year by Secretaría resolution; store per year. The 'paz y salvo' point is general practice (medium).",
      "reviewedByCounsel": false,
      "estimatedFromYear": 2026
    },
    {
      "id": "CO_PROP_PREDIAL_MEDELLIN",
      "country": "CO",
      "area": "property",
      "title": "Medellín property tax (predial) quarterly bill: may require review",
      "meaning": "Medellín bills predial by quarter, with due dates that depend on the property's sector; in 2026 owners who paid early and were up to date got a 5% discount.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyCity": [
            "medellin"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              2,
              13
            ],
            "end": [
              3,
              12
            ]
          },
          {
            "start": [
              4,
              30
            ],
            "end": [
              5,
              29
            ]
          },
          {
            "start": [
              7,
              31
            ],
            "end": [
              8,
              31
            ]
          },
          {
            "start": [
              10,
              30
            ],
            "end": [
              12,
              1
            ]
          }
        ]
      },
      "dueText": "Quarterly bills; each has a window without surcharge (2026 calendar).",
      "authority": "Secretaría de Hacienda, Alcaldía de Medellín",
      "consequence": "Surcharge after the first date, then interest and coactive collection.",
      "sources": [
        "https://www.medellin.gov.co/es/wp-content/uploads/2026/02/Calendario-tributario.pdf",
        "https://www.portafolio.co/mis-finanzas/vivienda/medellin-ofrece-descuento-del-5-en-el-predial-de-2026-para-contribuyentes-cumplidos-487028"
      ],
      "confidence": "medium",
      "notes": "Exact date within each window depends on the sector printed on the bill. Discount details (5%, conditions, deadline) from press, not the official calendar. Q4 2026 window is open on the research date.",
      "reviewedByCounsel": false,
      "estimatedFromYear": 2026
    },
    {
      "id": "CO_PROP_PREDIAL_OTHER",
      "country": "CO",
      "area": "property",
      "title": "Property tax (predial) in your municipality: may require review",
      "meaning": "Every municipality sets its own predial calendar and early-payment discount, usually in the first half of the year.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyCity": [
            "other"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              1,
              1
            ],
            "end": [
              6,
              30
            ]
          }
        ]
      },
      "dueText": "Set by each municipality; usually in the first half of the year.",
      "authority": "Municipal Secretaría de Hacienda",
      "consequence": "Interest and penalties; unpaid predial blocks a sale.",
      "sources": [
        "https://bogota.gov.co/mi-ciudad/hacienda/pago-de-impuestos-en-bogota-conoce-el-calendario-el-tributario-2026",
        "https://www.medellin.gov.co/es/wp-content/uploads/2026/02/Calendario-tributario.pdf"
      ],
      "confidence": "medium",
      "notes": "Typical window inferred from Bogotá and Medellín only. Add Cartagena, Santa Marta, Cali, Pereira calendars when those cities are in scope.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_VALORIZACION",
      "country": "CO",
      "area": "property",
      "title": "Valorización charge for nearby public works: may require review",
      "meaning": "Cities and departments can charge owners a one-off or instalment 'valorización' contribution when public works raise property values; it is billed per project, not every year.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "valorizacion bill received"
      },
      "dueText": "When it happens: valorizacion bill received.",
      "authority": "Municipality or department (in Bogotá, Instituto de Desarrollo Urbano, IDU)",
      "consequence": "Coactive collection, including embargo of accounts or the property; an account statement is needed for notarial sale.",
      "sources": [
        "https://www.notaria19bogota.com/impuesto-de-valorizacion/",
        "https://www.lincolninst.edu/publications/articles/evaluacion-la-contribucion-valorizacion-en-colombia"
      ],
      "confidence": "medium",
      "notes": "Notaría 19 page is from 2021; the Lincoln Institute article was not opened. No official statute opened.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_FOREIGN_INVESTMENT_REG",
      "country": "CO",
      "area": "property",
      "title": "Foreign investment registration for your property purchase: may require review",
      "meaning": "Money brought from abroad to buy property should enter through a Colombian bank (exchange market) and be declared as foreign investment; that declaration registers the investment with Banco de la República and is what later allows the money to be sent back out.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "boughtWithForeignFunds": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "At the time funds are converted; non-channeled investments can be registered at any time through the SIC"
      },
      "dueText": "At the time funds are converted; non-channeled investments can be registered at any time through the SIC.",
      "authority": "Banco de la República (Sistema de Información Cambiaria); exchange control enforcement by Superintendencia de Sociedades",
      "consequence": "Without registration the investor may be unable to prove the investment (for an investor visa) or repatriate the sale proceeds as foreign investment; exchange-regime sanctions are possible.",
      "sources": [
        "https://banrep.gov.co/politica-monetaria-cambiaria/regulacion-operaciones-cambiarias/inversion-extranjera-colombia-colombiana-exterior",
        "https://banrep.gov.co/sites/default/files/reglamentacion/archivos/decreto-1044-05-08-2026.pdf",
        "https://www.affirmalegal.com/blog/como-solicitar-una-visa-de-inversionista-en-colombia/"
      ],
      "confidence": "high",
      "notes": "Automatic registration through the exchange declaration and 'en cualquier tiempo' for non-channeled investments confirmed on the BanRep page (DUR 1068 de 2015 art. 2.17.2.5.1.1; Circular DCIP-83 ch. 7). Neither BanRep source names real estate specifically; applying it to property is from Affirma Legal (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_FOREIGN_INVESTMENT_CANCEL",
      "country": "CO",
      "area": "property",
      "title": "Sold your property, register the investment cancellation: may require review",
      "meaning": "When a registered foreign investment is sold or changed, the cancellation or substitution must be filed with Banco de la República before or when the proceeds are sent abroad; since August 2026 this can be done at any time.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "boughtWithForeignFunds": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "property sold or investment changed"
      },
      "dueText": "When it happens: property sold or investment changed.",
      "authority": "Banco de la República",
      "consequence": "Before Decreto 1044 de 2026 a filing after six months could be fined up to 200% of the amount; the decree removed the deadline and applies favorability to pending cases. DIAN may still ask for proof of registration for the sale.",
      "sources": [
        "https://banrep.gov.co/sites/default/files/reglamentacion/archivos/decreto-1044-05-08-2026.pdf",
        "https://banrep.gov.co/politica-monetaria-cambiaria/regulacion-operaciones-cambiarias/inversion-extranjera-colombia-colombiana-exterior"
      ],
      "confidence": "high",
      "notes": "Decree text was partly garbled in the PDF; the core change (six-month term removed) is clear. Gain on sale has its own tax (ganancia ocasional), not researched here.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_TOURIST_RENTAL_RNT",
      "country": "CO",
      "area": "property",
      "title": "Short-term rental: annual tourism register (RNT) update, may require review",
      "meaning": "Owners who rent property to tourists (vivienda turística, including through platforms) must hold a Registro Nacional de Turismo and update it each year in the first quarter, through the Cámara de Comercio.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "rentsShortTerm": [
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
      "dueText": "Each year by March 31.",
      "authority": "Ministerio de Comercio, Industria y Turismo; registration through Cámaras de Comercio (RUES)",
      "consequence": "Per the 2014 Bogotá notice: a fine of one SMMLV, suspension of the registration and temporary closure until updated.",
      "sources": [
        "https://bogota.gov.co/mi-ciudad/desarrollo-economico/en-marzo-vence-el-plazo-de-actualizacion-del-registro-nacional-de"
      ],
      "confidence": "low",
      "notes": "Only source opened is a 2014 notice; the current rule under Ley 2068 de 2020 and its decrees was not opened, and sanctions may have changed. Also check building (propiedad horizontal) rules on short-term rentals.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_RENTAL_INCOME",
      "country": "CO",
      "area": "property",
      "title": "Rental income from Colombian property, tax reporting: may require review",
      "meaning": "Rent is taxable income; tax residents report it in the annual return, and non-residents are usually taxed by withholding, filing only if the withholding did not cover the full tax.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "rentsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "sameAs",
        "ruleId": "CO_TAX_RENTA_INDIVIDUAL"
      },
      "dueText": "Same date as the related return.",
      "authority": "DIAN",
      "consequence": "Late-filing penalties and interest on unpaid tax.",
      "sources": [
        "https://siemprealdia.co/colombia/impuestos/personas-naturales-obligadas-a-declarar-renta/"
      ],
      "confidence": "medium",
      "notes": "Non-resident rate 35% on non-labor income per Siempre al Día (subject to treaties: a Canada-Colombia income tax treaty exists and there is no US-Colombia income tax treaty, from prior knowledge, not verified in this pass: low). Rental income also counts toward the 1,400 UVT filing threshold.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_PROP_TITLE_CHECK",
      "country": "CO",
      "area": "property",
      "title": "Check your property title certificate: may require review",
      "meaning": "The certificado de tradición y libertad shows the owner, liens and embargoes on a property; checking it once a year, and before any sale or loan, catches surprises early.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Once a year is a good habit; it is not a legal deadline.",
      "authority": "Superintendencia de Notariado y Registro (Oficinas de Registro de Instrumentos Públicos)",
      "consequence": "No legal penalty; this is a good-practice reminder.",
      "sources": [
        "https://bogota.gov.co/mi-ciudad/asi-puedes-descargar-el-certificado-de-tradicion-y-libertad-en-bogota"
      ],
      "confidence": "high",
      "notes": "Not a legal deadline. Certificate is bought online at certificados.supernotariado.gov.co (COP 35,900 in 2025).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_CO_MATRICULA_RENEWAL",
      "country": "CO",
      "area": "corporate",
      "title": "Company commercial registration renewal by 31 March: may require review",
      "meaning": "Every company (including an S.A.S.), branch, establishment and individual merchant registered with a Cámara de Comercio must renew its matrícula mercantil between 1 January and 31 March each year.",
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
      "dueText": "Each year by March 31.",
      "authority": "Cámara de Comercio of the company's domicile (RUES); sanctions by Superintendencia de Industria y Comercio or Supersociedades",
      "consequence": "Fines; after 5 years without renewal, companies are dissolved and enter liquidation, and natural-person registrations are cancelled (Ley 1727 de 2014 art. 31).",
      "sources": [
        "https://www.camaramedellin.com.co/Portals/0/Documentos/Documento de preguntas frecuentes renovación.pdf",
        "https://www.asuntoslegales.com.co/consumidor/si-no-renueva-la-matricula-mercantil-en-marzo-lo-pueden-sancionar-con-hasta-17-smmlv-3808182"
      ],
      "confidence": "high",
      "notes": "Código de Comercio art. 33; Decreto-Ley 019 de 2012 art. 166. Asuntos Legales headline cites fines of up to 17 SMMLV (article body not opened).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_CO_INCOME_TAX",
      "country": "CO",
      "area": "corporate",
      "title": "Company income tax return and installments: may require review",
      "meaning": "Companies that are not large taxpayers file the annual income tax return and pay in two installments, in May and July, on a date set by the last digit of the NIT.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "byIdDigits",
        "idName": "NIT",
        "ranges": [
          {
            "start": [
              5,
              12
            ],
            "end": [
              5,
              26
            ]
          },
          {
            "start": [
              7,
              9
            ],
            "end": [
              7,
              24
            ]
          }
        ]
      },
      "dueText": "Two installments, in May and July, on a day set by the last digit of the company's NIT (2026 calendar). Large taxpayers have other dates.",
      "authority": "DIAN",
      "consequence": "Late-filing penalty (sanción por extemporaneidad) and default interest.",
      "sources": [
        "https://www.valoraanalitik.com/?p=539463",
        "https://www.gerencie.com/calendario-dian"
      ],
      "confidence": "medium",
      "notes": "Windows from Gerencie summary table, months confirmed by Valora Analitik; per-digit dates not extracted. Régimen Simple companies follow a different calendar (annual SIMPLE return in April, bimonthly advances). Decreto 2229 de 2023.",
      "reviewedByCounsel": false,
      "estimatedFromYear": 2026
    },
    {
      "id": "CO_CO_ICA",
      "country": "CO",
      "area": "corporate",
      "title": "Municipal industry and commerce tax (ICA) return: may require review",
      "meaning": "Businesses pay ICA to each municipality where they operate; Medellín's 2026 annual return for 2025 was due 17 to 30 April by last NIT digit, and Bogotá sets its own dates.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Set by each municipality. In Medellín (2026) returns were due from April 17 to April 30 by the last digit of the NIT.",
      "authority": "Municipal Secretaría de Hacienda",
      "consequence": "Late penalties and interest.",
      "sources": [
        "https://www.medellin.gov.co/es/wp-content/uploads/2026/02/Calendario-tributario.pdf",
        "https://bogota.gov.co/mi-ciudad/hacienda/pago-de-impuestos-en-bogota-conoce-el-calendario-el-tributario-2026"
      ],
      "confidence": "medium",
      "notes": "Bogotá ICA dates are in Resolución SDH 000195 de 2025 (not opened). Applies to individuals carrying on business too.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_CO_RUB",
      "country": "CO",
      "area": "corporate",
      "title": "Beneficial owner registry (RUB) report or update: may require review",
      "meaning": "Colombian companies must report their beneficial owners to DIAN's RUB within two months of RUT registration, and update it when ownership changes, checked at the start of January, April, July and October.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Within 2 months of the company's RUT registration, then updated when owners change (checked each quarter).",
      "authority": "DIAN",
      "consequence": "Sanctions under Estatuto Tributario art. 658-3 for failing to report, reporting wrongly or not updating.",
      "sources": [
        "https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_1240_2022.htm",
        "https://actualicese.com/periodicidad-de-los-reportes-en-el-rub/"
      ],
      "confidence": "medium",
      "notes": "Initial 2-month rule confirmed in DIAN normograma (Res. 164 de 2021 art. 10 as modified by Res. 1240 de 2022). Quarterly checkpoint rule from Actualícese (2023 article); exact update deadline not found in the official text opened. Res. 219 de 2025 only changed dates for community action bodies.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_CO_FDI_FORM15",
      "country": "CO",
      "area": "corporate",
      "title": "Foreign-owned company: Banco de la República equity reconciliation (Formulario 15) by 30 June, may require review",
      "meaning": "A Colombian company with registered foreign investment that does not file financial statements with Supersociedades must send Banco de la República an annual equity reconciliation (Formulario 15) by 30 June.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyHasForeignShareholder": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          6,
          30
        ]
      },
      "dueText": "Each year by June 30.",
      "authority": "Banco de la República; sanctions by Superintendencia de Sociedades",
      "consequence": "Exchange-regime sanctions (Decreto 1746 de 1991), cited up to 200% of the amount not reported.",
      "sources": [
        "https://chambers.com/articles/actualización-de-inversión-extranjera-ante-el-banco-de-la-república",
        "https://www.asuntoslegales.com.co/consultorio/vence-plazo-para-reportar-el-registro-de-inversion-extranjera-2383966"
      ],
      "confidence": "medium",
      "notes": "Both sources are from 2016; the BanRep concept page opened did not show the deadline. Confirm the current DCIP-83 text.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_CO_ANNUAL_MEETING",
      "country": "CO",
      "area": "corporate",
      "title": "Annual shareholders' meeting and financial statements: may require review",
      "meaning": "Companies normally hold an ordinary shareholders' meeting each year to approve the prior year's financial statements, by the date in the bylaws or otherwise within the first three months of the year.",
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
      "dueText": "By March 31 each year, unless the bylaws set another date.",
      "authority": "Company organs; supervised by Superintendencia de Sociedades",
      "consequence": "Shareholders may meet by their own right after the deadline; unapproved statements complicate tax filings and Cámara renewal.",
      "sources": [],
      "confidence": "low",
      "notes": "Based on Código de Comercio art. 422 from prior knowledge; statute not opened during research. S.A.S. bylaws often set their own date.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_CO_BOOKS",
      "country": "CO",
      "area": "corporate",
      "title": "Accounting and corporate books kept up to date: may require review",
      "meaning": "Companies must keep accounting records under Colombian standards and keep minute and shareholder books, usually through a contador público.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Superintendencia de Sociedades; DIAN",
      "consequence": "Tax penalties for irregular books; evidentiary problems in disputes.",
      "sources": [],
      "confidence": "low",
      "notes": "Not researched with sources in this pass. Some companies also need a statutory auditor (revisor fiscal) depending on size.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_TAX_RESIDENCY_183",
      "country": "CO",
      "area": "tax",
      "title": "Days in Colombia approaching 183, tax residency: may require review",
      "meaning": "A person present in Colombia for more than 183 days, continuous or not, within any 365-day period becomes a Colombian tax resident, taxed on worldwide income and required to report foreign assets.",
      "when": {
        "all": {
          "livesInColombia": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Watch the count once you reach about 150 days in any 365.",
      "authority": "DIAN",
      "consequence": "Residency brings worldwide income tax, the foreign assets declaration and lower filing thresholds.",
      "sources": [
        "https://siemprealdia.co/colombia/impuestos/personas-naturales-obligadas-a-declarar-renta/"
      ],
      "confidence": "high",
      "notes": "Estatuto Tributario art. 10. Other residency criteria exist (e.g., diplomatic service, Colombian nationals with family or assets here). US citizens remain subject to US filing as well.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_TAX_FILING_TEST",
      "country": "CO",
      "area": "tax",
      "title": "Check whether you must file a Colombian income tax return: may require review",
      "meaning": "A tax resident must file if, for the year, gross assets exceeded 4,500 UVT on 31 December or gross income, card spending, purchases or bank deposits exceeded 1,400 UVT.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          7,
          31
        ]
      },
      "dueText": "Review before the August filing window opens.",
      "authority": "DIAN",
      "consequence": "Not filing when required leads to penalties for non-filing and late filing.",
      "sources": [
        "https://siemprealdia.co/colombia/impuestos/personas-naturales-obligadas-a-declarar-renta/"
      ],
      "confidence": "high",
      "notes": "For año gravable 2025 (filed 2026): 4,500 UVT = COP 224,095,500; 1,400 UVT = COP 69,718,600. Anyone who was responsable de IVA must file regardless. Date is ILP's suggested review date, not a legal deadline.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_TAX_RENTA_INDIVIDUAL",
      "country": "CO",
      "area": "tax",
      "title": "Individual income tax return due date by NIT digits: may require review",
      "meaning": "Individuals file the annual return between mid-August and late October, on a date set by the last two digits of their NIT; in 2026 the window ran from 12 August to 26 October.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "byIdDigits",
        "idName": "NIT",
        "ranges": [
          {
            "start": [
              8,
              12
            ],
            "end": [
              10,
              26
            ]
          }
        ]
      },
      "dueText": "Between August 12 and October 26, on a day set by the last two digits of your NIT (2026 calendar).",
      "authority": "DIAN",
      "consequence": "Late-filing penalty (generally 5% of tax per month or fraction, with minimums) plus interest on unpaid tax.",
      "sources": [
        "https://actualicese.com/vencimientos-en-declaracion-de-renta-personas-naturales-2026/",
        "https://www.valoraanalitik.com/?p=539463"
      ],
      "confidence": "high",
      "notes": "Decreto 2229 de 2023. Non-residents with a filing obligation use the same calendar. Penalty rate is general knowledge (ET art. 641), not opened (medium). 2027 per-digit dates not yet verified.",
      "reviewedByCounsel": false,
      "estimatedFromYear": 2026
    },
    {
      "id": "CO_TAX_FOREIGN_ASSETS",
      "country": "CO",
      "area": "tax",
      "title": "Foreign assets declaration if over 2,000 UVT: may require review",
      "meaning": "Tax residents whose assets outside Colombia were worth more than 2,000 UVT on 1 January must file a separate declaration of foreign assets, on the same dates as the income tax return, even if not otherwise required to file.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ],
          "hasForeignAssetsOver2000UVT": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "sameAs",
        "ruleId": "CO_TAX_RENTA_INDIVIDUAL"
      },
      "dueText": "Same date as the related return.",
      "authority": "DIAN",
      "consequence": "Penalties for late or non-filing; undeclared foreign assets can be treated as omitted assets.",
      "sources": [
        "https://actualicese.com/vencimientos-en-declaracion-de-renta-personas-naturales-2026/",
        "https://www.gerencie.com/calendario-dian"
      ],
      "confidence": "high",
      "notes": "2,000 UVT = COP 104,748,000 at the 2026 UVT. The form number was not confirmed (sources disagree in extraction): medium on form detail. Very relevant to US and Canadian retirees with home-country pensions and accounts.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_TAX_NONRESIDENT",
      "country": "CO",
      "area": "tax",
      "title": "Non-resident with Colombian income, filing check: may require review",
      "meaning": "A non-resident files a Colombian return only if they had Colombian-source income that was not fully covered by withholding at the legal rates; otherwise the withholding is the final tax.",
      "when": {
        "all": {
          "isTaxResident": [
            "no"
          ],
          "hasColombianIncome": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "sameAs",
        "ruleId": "CO_TAX_RENTA_INDIVIDUAL"
      },
      "dueText": "Same date as the related return.",
      "authority": "DIAN",
      "consequence": "Penalties and interest if a required return is not filed.",
      "sources": [
        "https://siemprealdia.co/colombia/impuestos/personas-naturales-obligadas-a-declarar-renta/"
      ],
      "confidence": "high",
      "notes": "ET arts. 407-411 (withholding for non-residents). Common case: rent paid by a Colombian tenant or agency.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_TAX_RUT",
      "country": "CO",
      "area": "tax",
      "title": "Tax registration (RUT) and updates: may require review",
      "meaning": "Anyone who must file or who carries on business needs a RUT with DIAN, and must update it when address, activity or responsibilities change.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "before first filing or on change"
      },
      "dueText": "When it happens: before first filing or on change.",
      "authority": "DIAN",
      "consequence": "Penalties for not registering or not updating; a RUT is needed to open many accounts and to file.",
      "sources": [],
      "confidence": "low",
      "notes": "No official DIAN page opened in this pass (search budget). Rule is well known but not sourced here.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_VEH_SOAT",
      "country": "CO",
      "area": "vehicle",
      "title": "SOAT mandatory vehicle insurance renewal: may require review",
      "meaning": "Every vehicle driven in Colombia needs SOAT, a one-year mandatory accident insurance policy, renewed before it lapses.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "soatExpiryDate",
        "days": 0,
        "windowStartDays": -15
      },
      "dueText": "On the date your SOAT expires.",
      "authority": "Insurers supervised by Superintendencia Financiera; enforced by traffic authorities; status shown in RUNT",
      "consequence": "Traffic fine and immobilization of the vehicle; without SOAT the técnico-mecánica inspection cannot be done.",
      "sources": [
        "https://www.grupor5.com/blog/soat/que-pasa-si-se-me-vence-el-soat",
        "https://www.bluradio.com/motor/multaran-a-todos-los-conductores-que-no-tengan-soat-al-hacer-la-tecnomecanica-so35"
      ],
      "confidence": "medium",
      "notes": "Fine amount not confirmed from an official text (commonly cited as 30 daily minimum wages, code D02); press sources conflict, so no amount stored.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_VEH_RTM",
      "country": "CO",
      "area": "vehicle",
      "title": "Técnico-mecánica and emissions inspection due: may require review",
      "meaning": "Private cars need a yearly technical and emissions inspection at a certified center (CDA) once they reach the first-inspection age; motorcycles from two years after registration.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "First inspection 6 years after registration for private cars (5 for cars registered after May 19, 2023; 2 for motorcycles), then every year.",
      "authority": "Ministerio de Transporte; Centros de Diagnóstico Automotor; recorded in RUNT",
      "consequence": "Traffic fine and possible immobilization.",
      "sources": [
        "https://www.cancilleria.gov.co/sites/default/files/Normograma/docs/pdf/ley_0769_2002_pr001.pdf",
        "https://www.fenalco.com.co/blog/juridico-2/notijuridico-163-mintransporte-hace-precisiones-sobre-la-primera-revision-tecnico-mecanica-segun-la-ley-2994-de-2023-2325"
      ],
      "confidence": "medium",
      "notes": "Ley 769 de 2002 arts. 51-52 (as amended by Decreto 19 de 2012): first at year 6 for private cars, annual after. Fenalco reports a 2023 law (cited as Ley 2294/2994 de 2023) moving the first inspection to year 5 for private cars registered after 19 May 2023, per MinTransporte Concepto 46801 de 2023.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_VEH_TAX_BOGOTA",
      "country": "CO",
      "area": "vehicle",
      "title": "Bogotá vehicle tax, early-payment discount date: may require review",
      "meaning": "Vehicles registered in Bogotá pay an annual vehicle tax; paying by the discount date saved 10% in 2026, or it could be split into two installments.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ],
          "vehicleRegisteredIn": [
            "bogota"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            5,
            15
          ],
          [
            7,
            24
          ]
        ]
      },
      "dueText": "Early-payment discount until May 15, final date July 24 (2026 calendar).",
      "authority": "Secretaría Distrital de Hacienda de Bogotá",
      "consequence": "Interest and penalties; unpaid tax blocks transfer of ownership.",
      "sources": [
        "https://bogota.gov.co/mi-ciudad/hacienda/pago-de-impuestos-en-bogota-conoce-el-calendario-el-tributario-2026"
      ],
      "confidence": "high",
      "notes": "Vehicle tax is departmental; Bogotá D.C. collects its own. Dates change yearly.",
      "reviewedByCounsel": false,
      "estimatedFromYear": 2026
    },
    {
      "id": "CO_VEH_TAX_ANTIOQUIA",
      "country": "CO",
      "area": "vehicle",
      "title": "Antioquia vehicle tax, early-payment discount date: may require review",
      "meaning": "Vehicles registered in Antioquia (including Medellín) pay an annual vehicle tax to the Gobernación, with early-payment discounts that ran to late April.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ],
          "vehicleRegisteredIn": [
            "antioquia"
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
      "dueText": "Discount for paying by about April 30 (2026 calendar).",
      "authority": "Gobernación de Antioquia, Secretaría de Hacienda",
      "consequence": "Interest and late penalties after the final date (in 2025, from 19 July).",
      "sources": [
        "https://www.antioquia.gov.co/antioquiacuenta/quedan-dos-dias-para-pagar-el-impuesto-vehicular-con-descuento-por-pronto-pago-en-antioquia",
        "https://abceconomia.co/2026/03/09/impuesto-vehicular-antioquia-2026-link-oficial-y-descuentos/"
      ],
      "confidence": "medium",
      "notes": "Official page is the 2025 notice (discounts 10% combustion, 15% hybrid, 20% electric; discount to 25 April, final 18 July 2025). 2026 discount end of 30 April from press; 2026 final date not found.",
      "reviewedByCounsel": false,
      "estimatedFromYear": 2026
    },
    {
      "id": "CO_LAB_PILA",
      "country": "CO",
      "area": "employment",
      "title": "Monthly social security payment (PILA) for your employee: may require review",
      "meaning": "Employers, including households with domestic staff, pay health, pension, occupational risk and family fund contributions each month through PILA, by a business day set by the last two digits of their ID.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthlyBusinessDays",
        "from": 2,
        "to": 16
      },
      "dueText": "Each month, between the 2nd and the 16th business day, on a day set by the last two digits of your ID.",
      "authority": "Ministerio de Salud y Protección Social (PILA); UGPP for enforcement",
      "consequence": "Default interest, UGPP fines and possible suspension of the worker's health coverage after 30 days in arrears.",
      "sources": [
        "https://siemprealdia.co/colombia/derecho-laboral/fechas-de-pago-de-la-seguridad-social/",
        "https://www.cancilleria.gov.co/sites/default/files/Normograma/docs/pdf/decreto_1990_2016.pdf"
      ],
      "confidence": "high",
      "notes": "Decreto 1990 de 2016. Full digit table not stored; only group endpoints confirmed. Decreto 1990 PDF listed but not opened.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_PRIMA_JUNE",
      "country": "CO",
      "area": "employment",
      "title": "First prima de servicios payment by 30 June: may require review",
      "meaning": "Employees, including domestic workers, receive a service bonus of 15 days' pay per half-year; the first half is due by 30 June.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          6,
          30
        ]
      },
      "dueText": "Each year by June 30.",
      "authority": "Ministerio del Trabajo",
      "consequence": "Labor claims, including indemnity for non-payment and Ministry fines.",
      "sources": [
        "https://www.gerencie.com/prestaciones-sociales-en-los-empleados-del-servicio-domestico.html",
        "https://www.lafm.com.co/economia/mintrabajo-prima-empleados-domesticos-debera-cancelarse-del-30-junio"
      ],
      "confidence": "high",
      "notes": "CST art. 306; extended to domestic workers by Ley 1788 de 2016. Proportional for part-year service.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_PRIMA_DECEMBER",
      "country": "CO",
      "area": "employment",
      "title": "Second prima de servicios payment by 20 December: may require review",
      "meaning": "The second half of the service bonus is due within the first 20 days of December.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
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
      "dueText": "Each year by December 20.",
      "authority": "Ministerio del Trabajo",
      "consequence": "Labor claims and fines.",
      "sources": [
        "https://www.gerencie.com/prestaciones-sociales-en-los-empleados-del-servicio-domestico.html",
        "https://accounter.co/noticias/actualidad/este-20-de-diciembre-tambien-vence-plazo-para-pago-de-prima-de-empleadas-domesticas"
      ],
      "confidence": "high",
      "notes": "Next occurrence after research date: 2026-12-20.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_CESANTIAS",
      "country": "CO",
      "area": "employment",
      "title": "Severance (cesantías) deposit to the fund by 14 February: may require review",
      "meaning": "Each year the employer deposits one month's salary per year worked (cesantías) into the employee's chosen severance fund by 14 February, not into the worker's hands.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          2,
          14
        ]
      },
      "dueText": "Each year by February 14.",
      "authority": "Ministerio del Trabajo",
      "consequence": "Late deposit triggers a daily penalty of one day's salary per day of delay (Ley 50 de 1990 art. 99), plus fines.",
      "sources": [
        "https://www.gerencie.com/prestaciones-sociales-en-los-empleados-del-servicio-domestico.html"
      ],
      "confidence": "high",
      "notes": "Ley 2466 de 2025 art. 64 allows agreeing in writing to monthly cesantías contributions (8.33%). The one-day-per-day penalty is general knowledge of art. 99, not quoted in the source (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_CESANTIAS_INTEREST",
      "country": "CO",
      "area": "employment",
      "title": "Interest on severance paid to the worker by 31 January: may require review",
      "meaning": "The employer pays the worker 12% a year interest on the cesantías balance, directly, by 31 January.",
      "when": {
        "all": {
          "hasEmployees": [
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
      "dueText": "Each year by January 31.",
      "authority": "Ministerio del Trabajo",
      "consequence": "Labor claims; unpaid interest can be doubled as a penalty.",
      "sources": [
        "https://www.gerencie.com/prestaciones-sociales-en-los-empleados-del-servicio-domestico.html"
      ],
      "confidence": "high",
      "notes": "12% rate and doubling penalty are general knowledge (Ley 52 de 1975), not in the opened source (medium on those details).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_DOTACION",
      "country": "CO",
      "area": "employment",
      "title": "Work clothing (dotación) delivery: may require review",
      "meaning": "Employees earning up to two minimum wages with more than three months' service receive work clothes and shoes three times a year, on 30 April, 31 August and 20 December; it cannot be paid in cash.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ],
          "employeeEarnsUpTo2SMMLV": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            4,
            30
          ],
          [
            8,
            31
          ],
          [
            12,
            20
          ]
        ]
      },
      "dueText": "Each year on April 30, August 31, December 20.",
      "authority": "Ministerio del Trabajo",
      "consequence": "Labor claims and fines.",
      "sources": [
        "https://www.gerencie.com/prestaciones-sociales-en-los-empleados-del-servicio-domestico.html",
        "https://actualicese.com/jornada-laboral-de-los-trabajadores-del-servicio-domestico-en-colombia-en-2026/"
      ],
      "confidence": "high",
      "notes": "CST arts. 230-232. 2 SMMLV = COP 3,501,810 in 2026.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_VACATION",
      "country": "CO",
      "area": "employment",
      "title": "Employee paid vacation due: may require review",
      "meaning": "Each year of service earns 15 business days of paid vacation, to be granted within the following year.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "employmentAnniversary",
        "years": 1,
        "annual": true
      },
      "dueText": "Each year on the employee's work anniversary (15 business days of paid vacation).",
      "authority": "Ministerio del Trabajo",
      "consequence": "Labor claims; accumulated vacation must be paid at termination.",
      "sources": [
        "https://www.gerencie.com/prestaciones-sociales-en-los-empleados-del-servicio-domestico.html"
      ],
      "confidence": "medium",
      "notes": "15 business days is CST art. 186 (general knowledge, not in the opened table).",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_MIN_WAGE_JANUARY",
      "country": "CO",
      "area": "employment",
      "title": "New minimum wage in January, update salaries: may require review",
      "meaning": "The minimum wage is reset each January; employees on it (often domestic staff) must be paid the new rate from 1 January, along with the transport allowance for those earning up to two minimum wages.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          1,
          1
        ]
      },
      "dueText": "Each year by January 1.",
      "authority": "Ministerio del Trabajo (decree)",
      "consequence": "Wage claims and fines; contributions computed on the wrong base.",
      "sources": [
        "https://www.portafolio.co/economia/gobierno/salario-minimo-de-2026-sigue-en-1-750-905-millones-tras-aclaracion-sobre-fallos-del-consejo-de-estado-504236"
      ],
      "confidence": "high",
      "notes": "2026: SMMLV COP 1,750,905; transport allowance COP 249,095. The 2026 decree is under nullity suits at the Consejo de Estado; Ministry says it remains in force (10 Oct 2026). Also feeds visa income thresholds.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_LAB_REFORM_2025",
      "country": "CO",
      "area": "employment",
      "title": "Labor reform changes for household staff: may require review",
      "meaning": "Ley 2466 de 2025 requires a written contract for domestic workers, cut the ordinary week to 42 hours from 15 July 2026 and raised the Sunday and holiday surcharge (90% from 1 July 2026).",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "once",
        "dates": [
          "2026-07-01",
          "2026-07-15"
        ]
      },
      "dueText": "Sunday surcharge to 90% from July 1, 2026; 42-hour week from July 15, 2026; a later step to 100% is expected.",
      "authority": "Ministerio del Trabajo",
      "consequence": "Back pay for unpaid surcharges or overtime; fines.",
      "sources": [
        "https://actualicese.com/jornada-laboral-de-los-trabajadores-del-servicio-domestico-en-colombia-en-2026/",
        "https://www.portafolio.co/economia/gobierno/atencion-desde-hoy-primero-de-julio-el-recargo-dominical-sube-al-90-y-la-reduccion-de-la-jornada-inicia-el-497268"
      ],
      "confidence": "medium",
      "notes": "Written contract under Ley 2466 art. 33 per Actualícese. Next step of Sunday surcharge (100%) reported by press; date not confirmed. Decreto 0993 de 2026 restates domestic worker benefits.",
      "reviewedByCounsel": false
    },
    {
      "id": "CO_EST_WILL_REVIEW",
      "country": "CO",
      "area": "estate",
      "title": "Colombian assets and your will: may require review",
      "meaning": "Colombian property passes under Colombian succession rules, often through a notary or court process in Colombia; owners commonly review whether a Colombian will is needed and whether their home-country will covers Colombian assets.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Every few years, and after a marriage, divorce, birth or property purchase.",
      "authority": "Notaries (Superintendencia de Notariado y Registro) and family courts",
      "consequence": "No penalty; without planning, heirs face a longer and costlier succession, and forced-heirship rules may override wishes.",
      "sources": [],
      "confidence": "low",
      "notes": "Search budget ran out before this item could be sourced. Forced heirship (legítima) and notarial succession are well known in Colombian law but are not verified here. Suggested interval is ILP's, not legal.",
      "reviewedByCounsel": false
    }
  ]
};
