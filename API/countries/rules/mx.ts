/**
 * API/countries/rules/mx.ts: Mexico (MX). GENERATED, do not edit by hand.
 * Source: docs/research/mexico.md (research date 2026-10-27), imported by
 * scripts/importCountryResearch.py. 37 rules (2 low confidence), 19 questions.
 * Every rule has reviewedByCounsel: false until a Mexico partner lawyer signs it off.
 */
import type { CountryRuleset } from "./engine.ts";

export const MX_RULESET: CountryRuleset = {
  "country": "MX",
  "researchDate": "2026-10-27",
  "questions": [
    {
      "key": "residencyStatus",
      "stage": "check",
      "question": "What is your immigration status in Mexico?",
      "type": "choice",
      "options": [
        {
          "value": "visitor",
          "label": "Visitor (tourist card or FMM)"
        },
        {
          "value": "residency_visa_not_yet_exchanged",
          "label": "I have a residency visa from a consulate and have not exchanged it for a card yet"
        },
        {
          "value": "temporary",
          "label": "Temporary resident"
        },
        {
          "value": "permanent",
          "label": "Permanent resident"
        },
        {
          "value": "mexican_citizen",
          "label": "Mexican citizen"
        },
        {
          "value": "not_living_in_mexico",
          "label": "I do not live in Mexico"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Residency rules set renewal dates and how long you can stay."
    },
    {
      "key": "ownsProperty",
      "stage": "check",
      "question": "Do you own real estate in Mexico?",
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
          "value": "buying_now",
          "label": "I am buying now",
          "sets": {
            "ownsProperty": "no",
            "purchasingProperty": "yes"
          }
        },
        {
          "value": "selling_now",
          "label": "I am selling now",
          "sets": {
            "ownsProperty": "yes",
            "sellingProperty": "yes"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Property owners usually pay local property tax and have a few yearly dates."
    },
    {
      "key": "holdingStructure",
      "stage": "check",
      "question": "How is the property held?",
      "type": "choice",
      "options": [
        {
          "value": "fideicomiso",
          "label": "Bank trust (fideicomiso)"
        },
        {
          "value": "direct_title",
          "label": "In my own name"
        },
        {
          "value": "mexican_company",
          "label": "Through a Mexican company"
        },
        {
          "value": "not_sure",
          "label": "I am not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "showIf": {
        "ownsProperty": [
          "yes",
          "buying_now",
          "selling_now"
        ]
      }
    },
    {
      "key": "propertyInRestrictedZone",
      "stage": "check",
      "question": "Is it within 50 km of a coast or 100 km of a border?",
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
          "value": "not_sure",
          "label": "I am not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "showIf": {
        "ownsProperty": [
          "yes",
          "buying_now",
          "selling_now"
        ]
      }
    },
    {
      "key": "rentsOutProperty",
      "stage": "check",
      "question": "Do you rent out property in Mexico?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "long_term",
          "label": "Yes, long-term",
          "sets": {
            "rentsOutProperty": [
              "yes",
              "long_term"
            ]
          }
        },
        {
          "value": "short_term_platform",
          "label": "Yes, short-term on a platform like Airbnb",
          "sets": {
            "rentsOutProperty": [
              "yes",
              "short_term_platform"
            ]
          }
        },
        {
          "value": "both",
          "label": "Both",
          "sets": {
            "rentsOutProperty": [
              "yes",
              "long_term",
              "short_term_platform",
              "both"
            ]
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Rental income usually has its own tax returns."
    },
    {
      "key": "hasCompany",
      "stage": "check",
      "question": "Do you own part of a Mexican company (S.A. de C.V., S. de R.L.)?",
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
          "value": "planning",
          "label": "I am planning one"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Companies have yearly filings, even when they do no business."
    },
    {
      "key": "ownsVehicle",
      "stage": "check",
      "question": "Do you keep a vehicle in Mexico?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "mexican_plates",
          "label": "Yes, with Mexican plates",
          "sets": {
            "ownsVehicle": "yes",
            "vehiclePlates": "mexican"
          }
        },
        {
          "value": "foreign_plates_with_TIP",
          "label": "Yes, foreign plates with an import permit (TIP)",
          "sets": {
            "ownsVehicle": "yes",
            "vehiclePlates": "foreign_with_TIP"
          }
        },
        {
          "value": "foreign_plates_no_permit",
          "label": "Yes, foreign plates without a permit",
          "sets": {
            "ownsVehicle": "yes",
            "vehiclePlates": "foreign_no_permit"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Vehicles have yearly fees, inspections and insurance dates."
    },
    {
      "key": "hasEmployees",
      "stage": "check",
      "question": "Do you employ anyone in Mexico?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "domestic_worker",
          "label": "A household worker"
        },
        {
          "value": "company_staff",
          "label": "Staff in a company"
        },
        {
          "value": "both",
          "label": "Both",
          "sets": {
            "hasEmployees": [
              "domestic_worker",
              "company_staff",
              "both"
            ]
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Employers, including households with staff, have monthly payments and yearly bonuses."
    },
    {
      "key": "hasMexicanWill",
      "stage": "check",
      "question": "Do you have a will made before a Mexican notary?",
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
          "value": "not_sure",
          "label": "I am not sure"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "state",
      "stage": "check",
      "question": "Which state is your main residence or property in?",
      "type": "choice",
      "options": [
        {
          "value": "Quintana Roo",
          "label": "Quintana Roo"
        },
        {
          "value": "Jalisco",
          "label": "Jalisco"
        },
        {
          "value": "Baja California Sur",
          "label": "Baja California Sur"
        },
        {
          "value": "Baja California",
          "label": "Baja California"
        },
        {
          "value": "Yucatán",
          "label": "Yucatán"
        },
        {
          "value": "Guanajuato",
          "label": "Guanajuato"
        },
        {
          "value": "Nayarit",
          "label": "Nayarit"
        },
        {
          "value": "Oaxaca",
          "label": "Oaxaca"
        },
        {
          "value": "CDMX",
          "label": "CDMX",
          "sets": {
            "vehicleState": "CDMX"
          }
        },
        {
          "value": "Estado de México",
          "label": "Estado de México",
          "sets": {
            "vehicleState": "EdoMex"
          }
        },
        {
          "value": "Sonora",
          "label": "Sonora"
        },
        {
          "value": "other",
          "label": "Another state"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Property tax, vehicle fees and some dates are set by each state."
    },
    {
      "key": "entryDateWithResidencyVisa",
      "stage": "check",
      "question": "When did you enter Mexico with your residency visa?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "residency_visa_not_yet_exchanged"
        ]
      },
      "why": "The card exchange is usually due within 30 days of that entry.",
      "help": "The date on your entry stamp or FMM. Skip this if you are not sure."
    },
    {
      "key": "residencyCardExpiry",
      "stage": "check",
      "question": "What is the expiry date on your resident card?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "temporary"
        ]
      },
      "why": "Renewal is usually filed in the 30 days before the card expires.",
      "help": "It is printed on the card. Skip this if you do not have it at hand."
    },
    {
      "key": "visitorAuthorizedUntil",
      "stage": "check",
      "question": "What is the last day of your authorized stay?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "visitor"
        ]
      },
      "why": "Visitors must leave or change status by that date.",
      "help": "It is on your FMM or entry record. Skip this if you are not sure."
    },
    {
      "key": "hasMinorChildrenWithResidency",
      "stage": "profile",
      "question": "Do you have children under 18 with Mexican residency?",
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
          "permanent"
        ]
      }
    },
    {
      "key": "hasEfirma",
      "stage": "profile",
      "question": "Do you have an e.firma from the SAT?",
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
      "key": "companyHasForeignShareholders",
      "stage": "profile",
      "question": "Does the company have shareholders from outside Mexico?",
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
      "key": "companyAbove110MThreshold",
      "stage": "profile",
      "question": "Are the company's assets or yearly income above MXN 110 million?",
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
      "key": "citizenship",
      "stage": "profile",
      "question": "Which citizenship do you hold?",
      "type": "choice",
      "options": [
        {
          "value": "US",
          "label": "United States"
        },
        {
          "value": "CA",
          "label": "Canada"
        },
        {
          "value": "other",
          "label": "Another country"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "mexicanTaxResidentWithIncome",
      "stage": "profile",
      "question": "Are you a Mexican tax resident with income in Mexico?",
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
    }
  ],
  "rules": [
    {
      "id": "MX_IMM_CARD_EXCHANGE",
      "country": "MX",
      "area": "immigration",
      "title": "Exchange your residency visa for a resident card: deadline may require review",
      "meaning": "After entering Mexico with a temporary or permanent residency visa from a consulate, you usually must go to INM and exchange it for the resident card within 30 calendar days.",
      "when": {
        "all": {
          "residencyStatus": [
            "residency_visa_not_yet_exchanged"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "entryDateWithResidencyVisa",
        "days": 30
      },
      "dueText": "30 days after the date you entered with your residency visa.",
      "authority": "Instituto Nacional de Migración (INM)",
      "consequence": "Missing the window can leave you without valid status and require a regularization procedure with fines.",
      "sources": [
        "https://embamex.sre.gob.mx/trinidadytobago/index.php/visas-y-servicios-a-extranjeros?id=119",
        "https://mley.mx/Reg_LMigra/articulo/59/index.html.md"
      ],
      "confidence": "high",
      "notes": "Reglamento de la Ley de Migración art. 59. The consequence wording is general; the exact regularization path depends on the case.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_IMM_TEMP_RENEWAL",
      "country": "MX",
      "area": "immigration",
      "title": "Temporary resident card renewal: date may require review",
      "meaning": "The temporary resident card is usually renewed by applying at INM during the 30 calendar days before it expires.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyCardExpiry",
        "windowStartDays": -30
      },
      "dueText": "In the 30 days before the card expires.",
      "authority": "Instituto Nacional de Migración (INM)",
      "consequence": "If the card expires without a renewal filed, the person generally has to regularize (with a fine) or restart from a consulate. A holder abroad can re-enter on an expired card for up to 55 calendar days under the INM guidelines.",
      "sources": [
        "https://dof.gob.mx/nota_detalle_popup.php?codigo=5276967",
        "https://papelea.com/mx/instituto-nacional-de-migracion/expedicion-de-documento-migratorio-por-renovacion-tramites-gobmx"
      ],
      "confidence": "medium",
      "notes": "The 30-day window is in the Lineamientos para trámites y procedimientos migratorios (DOF 2012, art. 17 fr. VI; re-entry rule art. 24). Those guidelines have been amended since, so confirm the current version. 2026 fees: MXN 5,570 (1 yr), 8,347 (2 yrs), 10,571 (3 yrs). Cards are issued for 1 to 4 years.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_IMM_TEMP_4YR_LIMIT",
      "country": "MX",
      "area": "immigration",
      "title": "Four-year limit on temporary residency: date may require review",
      "meaning": "Temporary residency can be renewed only until four years in total, after which people normally apply to change to permanent residency or obtain status another way.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "temporaryResidencyStartDate",
        "days": 1461,
        "windowStartDays": 1371
      },
      "dueText": "4 years after your temporary residency started.",
      "authority": "Instituto Nacional de Migración (INM)",
      "consequence": "If no change of status is filed before the final card expires, the person may lose legal status.",
      "sources": [
        "https://embamex.sre.gob.mx/trinidadytobago/index.php/visas-y-servicios-a-extranjeros?id=119"
      ],
      "confidence": "medium",
      "notes": "The SRE page confirms renewals up to four years. The change to permanent residency after four years is under Ley de Migración art. 54, which was not opened for this research.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_IMM_CHANGE_NOTICE",
      "country": "MX",
      "area": "immigration",
      "title": "Notify INM of a new address, job, marital status or nationality: deadline may require review",
      "meaning": "Temporary and permanent residents must tell INM within 90 days of a change of address, workplace, marital status or nationality.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary",
            "permanent"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "dateOfChange",
        "days": 90
      },
      "dueText": "90 days after the date of the change.",
      "authority": "Instituto Nacional de Migración (INM)",
      "consequence": "Fine of 20 to 100 days of general minimum wage (Ley de Migración art. 158). A missing notice can also delay later renewals.",
      "sources": [
        "https://mley.mx/LMigra/articulo/63/",
        "https://mley.mx/LMigra/articulo/158/",
        "https://vegaguerrero.com/migratory/resident-notifications-in-mexico-for-changes-in-the-stay-condition/?lang=en"
      ],
      "confidence": "high",
      "notes": "Ley de Migración art. 63. In practice, fines referenced to minimum wage are now often converted to UMA.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_IMM_PERM_MINOR_RENEWAL",
      "country": "MX",
      "area": "immigration",
      "title": "Permanent resident card for a child: renewal may require review",
      "meaning": "Adult permanent resident cards do not expire, but children's cards must be renewed yearly until age 3 and then every four years until 18.",
      "when": {
        "all": {
          "residencyStatus": [
            "permanent"
          ],
          "hasMinorChildrenWithResidency": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "childResidencyCardExpiry",
        "windowStartDays": -30
      },
      "dueText": "On the expiry date on your child's card.",
      "authority": "Instituto Nacional de Migración (INM)",
      "consequence": "An expired card for the child can complicate travel and other procedures.",
      "sources": [
        "https://embamex.sre.gob.mx/trinidadytobago/index.php/visas-y-servicios-a-extranjeros?id=119"
      ],
      "confidence": "high",
      "notes": "",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_IMM_VISITOR_STAY",
      "country": "MX",
      "area": "immigration",
      "title": "End of your authorized visitor stay: date may require review",
      "meaning": "Visitors without residency may stay only until the date INM authorized on entry, which can be up to 180 days but is often less.",
      "when": {
        "all": {
          "residencyStatus": [
            "visitor"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visitorAuthorizedUntil",
        "windowStartDays": -14
      },
      "dueText": "On the last day of your authorized stay.",
      "authority": "Instituto Nacional de Migración (INM)",
      "consequence": "Overstaying requires a regularization or exit procedure with a fine, and can affect future entries.",
      "sources": [
        "https://dof.gob.mx/nota_detalle_popup.php?codigo=5276967"
      ],
      "confidence": "high",
      "notes": "The 180-day maximum is in Lineamientos art. 14 fr. I c). Visitor status cannot be extended from inside Mexico. The authorized days are at the officer's discretion, so the member should enter the date on their FMM or entry stamp.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_VEH_TIP_EXPIRY",
      "country": "MX",
      "area": "vehicle",
      "title": "Foreign-plated car import permit (TIP) expiry: date may require review",
      "meaning": "A US- or Canadian-plated car is allowed in Mexico only while its Banjercito temporary import permit is valid, which runs as long as the owner's visitor or temporary resident status. It must leave and the permit must be cancelled at a border Banjercito office before the maximum return date.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ],
          "vehiclePlates": [
            "foreign_with_TIP"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "tipMaxReturnDate",
        "windowStartDays": -30
      },
      "dueText": "On the return date on your import permit.",
      "authority": "SAT / Aduanas; Banjercito (issues and cancels permits)",
      "consequence": "The deposit of USD 200-400 is lost, the record shows the vehicle as not returned (blocking future permits), and the vehicle can be subject to seizure.",
      "sources": [
        "https://mley.mx/LAdua/articulo/106/",
        "https://www.gob.mx/cms/uploads/attachment/file/874489/_Que_se_necesita_para_tramitar_un_permiso_.cleaned.pdf",
        "https://consulmex.sre.gob.mx/denver/index.php/non-mexicans/temporary-importation-of-foreign-vehicles"
      ],
      "confidence": "medium",
      "notes": "Ley Aduanera art. 106 fr. IV a) covers only visitors and temporary residents ('por el plazo que dure su condición de estancia, incluyendo sus renovaciones'). It is widely understood that a person who becomes a permanent resident can no longer keep a TIP car; the Denver consulate page suggests otherwise. Treat this as a trigger on 'changing to permanent' (medium). Free-zone and 'Sólo Sonora' or Baja exemptions exist but were not verified (low). Seizure risk is general knowledge, not read from a source.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_VEH_REFRENDO",
      "country": "MX",
      "area": "vehicle",
      "title": "Annual vehicle registration fee (refrendo) and tenencia: deadline may require review",
      "meaning": "Cars with Mexican plates pay an annual state fee, and in some states a tenencia tax that is often subsidized if paid on time, usually in the first quarter.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ],
          "vehiclePlates": [
            "mexican"
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
      "authority": "State finance secretariat (Secretaría de Finanzas / Administración y Finanzas)",
      "consequence": "Loss of discounts or subsidies, surcharges and fines; can block plate renewal, sale or verification.",
      "sources": [
        "https://www.unotv.com/nacional/se-acaba-el-descuento-del-refrendo-2026-consulta-la-fecha-limite-en-cdmx-y-estados/",
        "https://www.unotv.com/estados/ciudad-de-mexico/predial-cdmx-2026-descuento-del-8-si-pagas-en-enero-asi-lo-tramitas/"
      ],
      "confidence": "medium",
      "notes": "Varies by state. 2026 deadlines: CDMX, Jalisco, Puebla, Tamaulipas and Baja California March 31; Estado de México April 6; Morelos May. CDMX 2026 refrendo was MXN 760 with a 100% tenencia subsidy for cars up to MXN 638,000. Yucatán and others charge no tenencia. The general rule is March 31.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_VEH_VERIFICACION",
      "country": "MX",
      "area": "vehicle",
      "title": "Vehicle emissions test (verificación): date may require review",
      "meaning": "In Mexico City, the State of Mexico and other Megalópolis states, Mexican-plated cars must pass an emissions test twice a year, in a two-month window set by sticker color and the last plate digit.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ],
          "vehiclePlates": [
            "mexican"
          ],
          "vehicleState": [
            "CDMX",
            "EdoMex"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Twice a year, in months set by the last digit of the plate (CDMX and Estado de México).",
      "authority": "State environment secretariat (CDMX: SEDEMA)",
      "consequence": "Late-verification fine (2026: MXN 2,263 CDMX, MXN 3,394 EdoMex) and possible circulation restrictions.",
      "sources": [
        "https://www.unotv.com/nacional/verificacion-cdmx-y-edomex-2026-calendario-del-segundo-semestre-revisa-cuando-te-toca/"
      ],
      "confidence": "medium",
      "notes": "Applies only in states with a verification program. Many popular expat states (for example Yucatán, Quintana Roo, Baja California Sur) have no comparable program or a different one; not verified. First-half calendar not captured; the same digit pairs repeat Jan-Jun.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_VEH_INSURANCE",
      "country": "MX",
      "area": "vehicle",
      "title": "Mexican auto liability insurance renewal: date may require review",
      "meaning": "Every vehicle on federal roads must carry at least liability insurance, and the owner is responsible for buying it. Most US and Canadian policies do not cover Mexico, so a Mexican policy is usually needed.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "autoPolicyExpiry",
        "windowStartDays": -15
      },
      "dueText": "On the date your policy expires.",
      "authority": "SICT / Guardia Nacional (enforcement); CNSF (insurers)",
      "consequence": "Fines and possible impoundment after an accident; personal liability for damages.",
      "sources": [
        "https://mley.mx/LCPAF/articulo/63-bis/"
      ],
      "confidence": "medium",
      "notes": "The legal requirement (Ley de Caminos art. 63 Bis) is high confidence. The statement that foreign policies are generally not valid in Mexico is common guidance but was not read in an official source. States may also require insurance on state roads.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_PROP_PREDIAL",
      "country": "MX",
      "area": "property",
      "title": "Annual property tax (predial) with early-payment discount: deadline may require review",
      "meaning": "Property owners pay an annual municipal property tax; most municipalities give a discount for paying the full year in January (and sometimes February or March).",
      "when": {
        "all": {
          "ownsProperty": [
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
      "dueText": "Discount for paying the year by the end of January (some cities, like CDMX, also allow installments).",
      "authority": "Municipal treasury (Tesorería municipal); CDMX: Secretaría de Administración y Finanzas",
      "consequence": "Lost discount, then surcharges and fines; the debt attaches to the property and must be cleared before sale or transfer.",
      "sources": [
        "https://www.unotv.com/estados/ciudad-de-mexico/predial-cdmx-2026-descuento-del-8-si-pagas-en-enero-asi-lo-tramitas/"
      ],
      "confidence": "medium",
      "notes": "Varies by municipality. CDMX 2026: 8% discount if the full year is paid in January, 5% in February; otherwise bimonthly. Many coastal municipalities offer January-March discounts, not verified individually. The general rule is a January 31 reminder. Water bills are separate.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_PROP_FIDEICOMISO_FEE",
      "country": "MX",
      "area": "property",
      "title": "Annual bank trust (fideicomiso) fee: date may require review",
      "meaning": "Foreigners holding residential property near the coast or border through a bank trust pay the bank an annual trustee fee under the trust contract.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyInRestrictedZone": [
            "yes"
          ],
          "holdingStructure": [
            "fideicomiso"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "trustAnniversaryDate",
        "annual": true,
        "windowStartDays": -30
      },
      "dueText": "Each year on the trust's anniversary.",
      "authority": "Trustee bank (contract); SRE permit",
      "consequence": "Late fees under the contract; prolonged non-payment can complicate a sale, inheritance or the trust itself.",
      "sources": [
        "https://portales.sre.gob.mx/tramites-dgaj/art-27-constitucional/permiso-para-constitucion-de-fideicomiso-sobre-inmuebles-localizados-dentro-de-la-zona-restringida",
        "https://globallawexperts.com/fideicomiso-property-mexico/"
      ],
      "confidence": "medium",
      "notes": "The fee amount and date are set by contract and vary by bank (no reliable range found). Consequences beyond late fees are contract-specific (low).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_PROP_FIDEICOMISO_TERM",
      "country": "MX",
      "area": "property",
      "title": "Bank trust term ending (50 years): extension may require review",
      "meaning": "A restricted-zone trust lasts up to 50 years and can be extended; the extension should be requested through the bank before the term ends.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyInRestrictedZone": [
            "yes"
          ],
          "holdingStructure": [
            "fideicomiso"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "trustStartDate",
        "years": 50,
        "windowStartDays": 17897
      },
      "dueText": "50 years after the trust started; it can be extended.",
      "authority": "Trustee bank; Secretaría de Relaciones Exteriores (SRE)",
      "consequence": "If not extended, the trust term ends and the beneficiary's rights must be restructured.",
      "sources": [
        "https://sdv.com.mx/compendio/ley-de-inversion-extranjera/",
        "https://portales.sre.gob.mx/tramites-dgaj/art-27-constitucional/permiso-para-constitucion-de-fideicomiso-sobre-inmuebles-localizados-dentro-de-la-zona-restringida"
      ],
      "confidence": "high",
      "notes": "Ley de Inversión Extranjera art. 13: 'hasta cincuenta años, con posibilidad de prórroga'. Rarely due soon, but useful to record for buyers of older trusts (assignment of rights).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_PROP_FIDEICOMISO_RNIE",
      "country": "MX",
      "area": "property",
      "title": "Foreign investment registry (RNIE) record for your bank trust: status may require review",
      "meaning": "Trusts that give foreigners rights over Mexican real estate must be registered in the national foreign investment registry; the trustee bank usually handles it, but owners should confirm.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "holdingStructure": [
            "fideicomiso"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Secretaría de Economía, Registro Nacional de Inversiones Extranjeras",
      "consequence": "RNIE fines of 30 to 100 UMA for omissions (per IDC Online).",
      "sources": [
        "https://www.ey.com/es_mx/services/tax/inversion-extranjera-mexico-cumplir-con-rnie-2026",
        "https://sdv.com.mx/compendio/ley-de-inversion-extranjera/"
      ],
      "confidence": "medium",
      "notes": "LIE art. 32. Whether individual beneficiaries owe their own annual reports for a residential trust was not confirmed (low); the annual report applies only above the MXN 110M thresholds.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_PROP_ISAI",
      "country": "MX",
      "area": "property",
      "title": "Property acquisition tax (ISAI) after a purchase: deadline may require review",
      "meaning": "Buying real estate triggers a one-time state or municipal acquisition tax, normally paid through the notary at signing and due about 15 business days after the purchase.",
      "when": {
        "all": {
          "purchasingProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "deedSigningDate",
        "businessDays": 15
      },
      "dueText": "15 business days after the date the deed was signed.",
      "authority": "Municipal or state treasury (collected via the notary)",
      "consequence": "Surcharges and fines; the deed cannot be registered in the Registro Público de la Propiedad until it is paid.",
      "sources": [
        "https://expansion.mx/finanzas-personales/2024/11/27/cuando-se-paga-el-isai"
      ],
      "confidence": "medium",
      "notes": "Name, rate (roughly 2-5%, not verified per state) and deadline vary by state or municipality. The base is usually the highest of price, cadastral value or appraisal. One-time, but a common onboarding question.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_PROP_SALE_ISR",
      "country": "MX",
      "area": "property",
      "title": "Income tax on selling Mexican property: amount may require review",
      "meaning": "Selling property in Mexico triggers income tax on the gain, which the notary calculates and pays within 15 days. Non-residents pay 25% of the gross price, or the top rate on the gain with a Mexican representative. A primary home may be exempt up to 700,000 UDIS, once every three years.",
      "when": {
        "all": {
          "sellingProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "saleDeedDate",
        "days": 15
      },
      "dueText": "15 days after the date of the sale deed.",
      "authority": "SAT (withheld and paid by the notary)",
      "consequence": "The notary will not close without calculating the tax; a wrong residency claim can lead to assessments.",
      "sources": [
        "https://mley.mx/LISR/articulo/160/",
        "https://mley.mx/LISR/articulo/93/"
      ],
      "confidence": "high",
      "notes": "LISR arts. 93 fr. XIX a) and 160; the top rate under art. 152 is 35%. The home exemption in practice requires proving Mexican tax residency (RFC, proof of address); that requirement is not in the text read (medium). Also check US/Canadian tax on the same sale.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_TAX_RFC",
      "country": "MX",
      "area": "tax",
      "title": "Mexican tax ID (RFC) registration: status may require review",
      "meaning": "Anyone with Mexican taxable activity, such as renting out property, running a company or selling property as a resident, generally needs an RFC from SAT, and many banks and notaries ask for it.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "rentsOutProperty": [
              "yes"
            ]
          },
          {
            "hasCompany": [
              "yes"
            ]
          }
        ]
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Without an RFC, platforms withhold at higher rates and the member cannot file returns or issue CFDI invoices.",
      "sources": [
        "https://www.siigo.com/mx/blog/obligaciones-fiscales/regimen-plataformas-digitales-sat-obligaciones/"
      ],
      "confidence": "medium",
      "notes": "The legal basis is CFF art. 27, not opened. The higher withholding without an RFC is reported by Siigo.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_TAX_ANNUAL_INDIVIDUAL",
      "country": "MX",
      "area": "tax",
      "title": "Annual individual tax return (April): deadline may require review",
      "meaning": "Individuals with rental, professional or business income in Mexico, or above certain thresholds, file an annual return with SAT between April 1 and April 30.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "rentsOutProperty": [
              "yes"
            ]
          },
          {
            "mexicanTaxResidentWithIncome": [
              "yes"
            ]
          }
        ]
      },
      "due": {
        "kind": "annual",
        "on": [
          4,
          30
        ]
      },
      "dueText": "Each year by April 30.",
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Late-filing fines plus surcharges and inflation adjustment on unpaid tax.",
      "sources": [
        "https://www.unotv.com/negocios/declaracion-anual-2026-quienes-estan-obligados-a-presentarla-ante-el-sat/"
      ],
      "confidence": "high",
      "notes": "Obligated filers include those with rental (arrendamiento) income or income above MXN 400,000. Non-resident landlords are taxed differently (withholding regime), not covered here (low).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_TAX_RENTAL_MONTHLY",
      "country": "MX",
      "area": "tax",
      "title": "Monthly tax payment on rental income (17th): deadline may require review",
      "meaning": "Individuals who rent out Mexican property usually make a monthly provisional income tax payment by the 17th of the following month, deducting actual expenses or a flat 35%.",
      "when": {
        "all": {
          "rentsOutProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": 17
      },
      "dueText": "By the 17th of the following month.",
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Surcharges and fines for late or missing payments; SAT may restrict CFDI certificates.",
      "sources": [
        "https://sdv.com.mx/compendio/ley-isr/articulo-116/"
      ],
      "confidence": "high",
      "notes": "LISR art. 116; companies paying rent withhold 10%. A quarterly-payment option for small residential rents exists in the law but was not confirmed in the text read (medium). Unfurnished residential rent is generally IVA-exempt, while furnished, short-term or commercial rent attracts IVA (not verified here; medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_TAX_RENTAL_PLATFORM",
      "country": "MX",
      "area": "tax",
      "title": "Short-term rental platforms and local lodging tax: obligations may require review",
      "meaning": "If you rent through Airbnb or similar platforms, the platform usually withholds 4% ISR and 8% IVA when you give it your RFC (more without one), and many states charge a separate lodging tax you may have to register for and pay.",
      "when": {
        "all": {
          "rentsOutProperty": [
            "short_term_platform"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Monthly; the state lodging tax follows each state's rules.",
      "authority": "SAT; state finance secretariat (impuesto sobre hospedaje)",
      "consequence": "Higher withholding without an RFC; state fines for unregistered lodging.",
      "sources": [
        "https://www.siigo.com/mx/blog/obligaciones-fiscales/regimen-plataformas-digitales-sat-obligaciones/"
      ],
      "confidence": "medium",
      "notes": "2026: the general platform withholding rose to 2.5%, but hospedaje is reported as staying at 4%. State lodging tax rates and registration rules vary (not verified per state).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_TAX_EFIRMA",
      "country": "MX",
      "area": "tax",
      "title": "SAT e.firma expiry (every 4 years): renewal may require review",
      "meaning": "The SAT electronic signature expires four years after issue or last renewal. It can be renewed online while valid, through SAT ID if expired less than a year, or in person if expired longer.",
      "when": {
        "all": {
          "hasEfirma": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "efirmaIssueDate",
        "days": 1461,
        "windowStartDays": 1401
      },
      "dueText": "4 years after your e.firma was issued.",
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Without a valid e.firma you cannot sign returns or many SAT procedures; tax obligations continue.",
      "sources": [
        "https://www.elimparcial.com/dinero/2026/10/13/efirma-cuando-vence-y-como-renovarla-sin-ir-a-la-oficina/"
      ],
      "confidence": "high",
      "notes": "Also applies to a company's own e.firma, renewed by its legal representative.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_ANNUAL_RETURN",
      "country": "MX",
      "area": "corporate",
      "title": "Company annual tax return (March 31): deadline may require review",
      "meaning": "Mexican companies (S.A. de C.V., S. de R.L.) file their annual income tax return with SAT by March 31 for the prior year.",
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
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Fines, surcharges and possible restriction of the company's CFDI certificate.",
      "sources": [
        "https://www.unotv.com/negocios/declaracion-anual-2026-quienes-estan-obligados-a-presentarla-ante-el-sat/"
      ],
      "confidence": "high",
      "notes": "Applies even to dormant companies (general practice; medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_MONTHLY_TAX",
      "country": "MX",
      "area": "corporate",
      "title": "Company monthly tax filings (17th): deadline may require review",
      "meaning": "Companies generally make monthly provisional income tax and VAT filings by the 17th of the following month, even with no activity.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": 17
      },
      "dueText": "By the 17th of the following month.",
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Fines and surcharges; repeated omissions can lead to restricted invoicing.",
      "sources": [
        "https://sdv.com.mx/compendio/ley-isr/articulo-116/"
      ],
      "confidence": "medium",
      "notes": "The day-17 rule for corporate provisional payments (LISR art. 14) was not opened; the cited source shows the same deadline for individuals. Usually handled by the company's accountant.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_SHAREHOLDER_MEETING",
      "country": "MX",
      "area": "corporate",
      "title": "Annual shareholders' meeting (within 4 months of year-end): date may require review",
      "meaning": "A corporation must hold an ordinary shareholders' meeting at least once a year within four months after its fiscal year closes (usually by April 30) to approve the directors' report and financial statements.",
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
        ]
      },
      "dueText": "Each year by April 30.",
      "authority": "Company law (LGSM); no filing authority for ordinary minutes",
      "consequence": "Gaps in corporate records cause problems with banks, notaries, due diligence and a later sale or dissolution.",
      "sources": [
        "https://mley.mx/LGSM/articulo/181/"
      ],
      "confidence": "high",
      "notes": "LGSM art. 181 applies to S.A. An S. de R.L. holds partner meetings as its bylaws provide, at least yearly (LGSM art. 80, not opened; medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_BENEFICIAL_OWNER",
      "country": "MX",
      "area": "corporate",
      "title": "Beneficial owner (beneficiario controlador) records: update may require review",
      "meaning": "Companies and trusts must keep accurate, current records of who ultimately owns or controls them and give them to SAT within 15 business days of a request.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "hasCompany": [
              "yes"
            ]
          },
          {
            "holdingStructure": [
              "fideicomiso"
            ]
          }
        ]
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Change in ownership or control; SAT request (15 business days, plus 10 on extension)",
      "authority": "Servicio de Administración Tributaria (SAT)",
      "consequence": "Significant fines under CFF arts. 84-M and 84-N.",
      "sources": [
        "https://mley.mx/CFF/articulo/32-b-ter/index.html.md"
      ],
      "confidence": "high",
      "notes": "CFF art. 32-B Ter, in force since 2022. Fine amounts were not read (art. 84-N not opened).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_BOOKS",
      "country": "MX",
      "area": "corporate",
      "title": "Corporate books and partner register notice: status may require review",
      "meaning": "Companies must keep share or partner registers and minute books up to date. An S. de R.L. must also publish partner-register entries in the Secretaría de Economía electronic system (PSM).",
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
      "dueText": "Share transfer, capital change, new partner.",
      "authority": "Secretaría de Economía (PSM); company administrators",
      "consequence": "Transfers do not bind third parties until recorded; administrators are personally liable for the register.",
      "sources": [
        "https://mley.mx/LGSM/articulo/73/"
      ],
      "confidence": "high",
      "notes": "LGSM art. 73 (S. de R.L.).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_RNIE_REGISTRATION",
      "country": "MX",
      "area": "corporate",
      "title": "Foreign investment registry (RNIE) registration: deadline may require review",
      "meaning": "A Mexican company with foreign shareholders must register in the RNIE within 40 business days of incorporation or of the foreign investor joining.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyHasForeignShareholders": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "incorporationOrForeignEntryDate",
        "businessDays": 40
      },
      "dueText": "40 business days after the date the company was formed or a foreign partner joined.",
      "authority": "Secretaría de Economía, Registro Nacional de Inversiones Extranjeras",
      "consequence": "Fines; notaries must report the omission to the RNIE.",
      "sources": [
        "https://sdv.com.mx/compendio/ley-de-inversion-extranjera/",
        "https://www.ey.com/es_mx/services/tax/inversion-extranjera-mexico-cumplir-con-rnie-2026"
      ],
      "confidence": "high",
      "notes": "LIE arts. 32-34. Filed only on the RNIE digital platform since 2025.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_RNIE_QUARTERLY",
      "country": "MX",
      "area": "corporate",
      "title": "RNIE quarterly notice (within 10 business days of quarter end): deadline may require review",
      "meaning": "A foreign-owned company files a quarterly RNIE notice only if, that quarter, it changed name, tax address or activity, or had capital or intercompany movements above MXN 20 million.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyHasForeignShareholders": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Within 10 business days after March 31, June 30, September 30 and December 31, only when the thresholds are met.",
      "authority": "Secretaría de Economía, RNIE",
      "consequence": "Fines of 30 to 100 daily UMA for omission or late filing (LIE art. 38 fr. IV).",
      "sources": [
        "https://idconline.mx/corporativo/2024/07/23/aviso-trimestral-rnie-sanciones-por-incumplimiento",
        "https://www.ey.com/es_mx/services/tax/inversion-extranjera-mexico-cumplir-con-rnie-2026"
      ],
      "confidence": "high",
      "notes": "Most small expat companies will not cross the MXN 20M threshold, but name, address or activity changes trigger it regardless.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_CO_RNIE_ANNUAL",
      "country": "MX",
      "area": "corporate",
      "title": "RNIE annual economic report (April or May): deadline may require review",
      "meaning": "A foreign-owned company files an annual RNIE economic report in April (names A-J) or May (K-Z) only if assets, liabilities, income or expenses reached MXN 110 million or more.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ],
          "companyHasForeignShareholders": [
            "yes"
          ],
          "companyAbove110MThreshold": [
            "yes"
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
      "dueText": "April 30 (May 31 for company names starting K to Z).",
      "authority": "Secretaría de Economía, RNIE",
      "consequence": "Fines of 30 to 100 daily UMA.",
      "sources": [
        "https://www.ey.com/es_mx/services/tax/inversion-extranjera-mexico-cumplir-con-rnie-2026",
        "https://sdv.com.mx/compendio/ley-de-inversion-extranjera/"
      ],
      "confidence": "medium",
      "notes": "LIE art. 35 speaks of annual renewal of the registration certificate for all registrants; per EY the annual report is required only above the threshold. Confirm with counsel whether smaller companies owe any annual filing (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_LAB_IMSS_DOMESTIC",
      "country": "MX",
      "area": "employment",
      "title": "IMSS social security for your domestic worker: registration and payments may require review",
      "meaning": "If you employ a housekeeper, gardener, cook or similar worker in your home, you must register them with IMSS from the first day and pay contributions for the period you choose (monthly or longer, paid through the IMSS platform).",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_worker"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Per the payment period you choose: daily, monthly, every two months, every six months or yearly.",
      "authority": "Instituto Mexicano del Seguro Social (IMSS)",
      "consequence": "The employer can owe back contributions with surcharges and fines, and is liable for costs of illness or injury the IMSS would have covered.",
      "sources": [
        "https://www.elcontribuyente.mx/2022/11/como-se-afilia-a-una-trabajadora-del-hogar-al-imss",
        "https://gaceta.diputados.gob.mx/PDF/65/2022/oct/DOF16NOV2022-VariosLeySeguroSocialTrabajadoresHogar.pdf"
      ],
      "confidence": "medium",
      "notes": "Mandatory under the Ley del Seguro Social reform published 2022-11-16 (high). Payment-period mechanics are from secondary sources; the official IMSS page did not load (medium). Consequence wording is general, not read in a source.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_LAB_AGUINALDO",
      "country": "MX",
      "area": "employment",
      "title": "Year-end bonus (aguinaldo) before December 20: deadline may require review",
      "meaning": "Every employee, including domestic workers, is owed at least 15 days' salary as a year-end bonus paid before December 20, prorated for less than a full year.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_worker",
            "company_staff"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          12,
          19
        ]
      },
      "dueText": "Each year by December 19.",
      "authority": "Secretaría del Trabajo y Previsión Social (STPS); PROFEDET; labor courts",
      "consequence": "The worker can claim it, with penalties, through PROFEDET or the labor courts; fines for employers.",
      "sources": [
        "https://mley.mx/LFT/articulo/87/"
      ],
      "confidence": "high",
      "notes": "LFT art. 87 says 'antes del día veinte de diciembre', so the last safe day is December 19.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_LAB_VACATION",
      "country": "MX",
      "area": "employment",
      "title": "Employee vacation days and vacation premium: entitlement may require review",
      "meaning": "After one year of service, employees get at least 12 working days of paid vacation, rising by two days a year to 20 and then by two every five years, plus a vacation premium of at least 25% of that pay.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_worker",
            "company_staff"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "employeeHireDateAnniversary",
        "annual": true,
        "windowStartDays": -30
      },
      "dueText": "Each year on the employee's work anniversary.",
      "authority": "STPS; labor courts",
      "consequence": "Back pay and penalties if claimed, typically at termination.",
      "sources": [
        "https://mley.mx/LFT/articulo/76/"
      ],
      "confidence": "high",
      "notes": "LFT art. 76, 2023 reform. The 25% premium is LFT art. 80 (not opened; well established).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_LAB_WORKWEEK_2027",
      "country": "MX",
      "area": "employment",
      "title": "Maximum workweek drops to 46 hours on January 1, 2027: schedules may require review",
      "meaning": "A 2026 constitutional reform cuts the maximum workweek in steps: 46 hours in 2027, 44 in 2028, 42 in 2029 and 40 in 2030.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_worker",
            "company_staff"
          ]
        }
      },
      "due": {
        "kind": "once",
        "dates": [
          "2027-01-01"
        ]
      },
      "dueText": "January 1, 2027: 46 hours; then 44 in 2028, 42 in 2029 and 40 in 2030.",
      "authority": "STPS",
      "consequence": "Hours beyond the cap become overtime with premium pay.",
      "sources": [
        "https://www.hklaw.com/en/insights/publications/2026/03/mexico-officially-enacts-constitutional-reform"
      ],
      "confidence": "medium",
      "notes": "Published in the DOF 2026-03-03. Domestic workers already have their own hours rules under LFT; whether and how the phase-down applies to them was not confirmed (low).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_EST_WILL",
      "country": "MX",
      "area": "estate",
      "title": "Mexican will for property in Mexico: plan may require review",
      "meaning": "Owners of Mexican property (directly or through a trust) are commonly advised to make a Mexican will before a notary. Notaries offer discounted wills each September (Mes del Testamento).",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "hasMexicanWill": [
            "no"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          9,
          1
        ]
      },
      "dueText": "Any time; notaries offer discounts in September (Mes del Testamento).",
      "authority": "State notaries (Colegios de Notarios) with Secretaría de Gobernación",
      "consequence": "Without a Mexican will, heirs may face a slower, costlier succession in Mexico even with a valid foreign will.",
      "sources": [
        "https://www.adn40.mx/mexico/2026-09-08/mes-del-testamento-2026-lista-de-precios-por-estado/"
      ],
      "confidence": "medium",
      "notes": "2026 September prices ranged from about MXN 1,000 (Chiapas) to 4,100 (Nayarit), CDMX 3,800, with discounts up to 50%. The consequence for heirs is common practitioner guidance, not read in an official source (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_EST_TRUST_BENEFICIARIES",
      "country": "MX",
      "area": "estate",
      "title": "Substitute beneficiaries in your bank trust: designation may require review",
      "meaning": "A fideicomiso can name substitute beneficiaries who take over on death, which can avoid probate for that property; it should be reviewed after marriage, divorce or death in the family.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "holdingStructure": [
            "fideicomiso"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Family change.",
      "authority": "Trustee bank; notary",
      "consequence": "An outdated designation can send the property through succession proceedings.",
      "sources": [
        "https://globallawexperts.com/fideicomiso-property-mexico/"
      ],
      "confidence": "low",
      "notes": "Widely described by practitioners, but the opened source did not address substitute beneficiaries. Verify with a notary or bank.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_ID_CURP_BIOMETRIC",
      "country": "MX",
      "area": "identity",
      "title": "Biometric CURP for foreign residents: requirement may require review",
      "meaning": "Mexico began rolling out a CURP with photo and fingerprints in 2026; reports conflict on whether foreign residents must obtain it and when.",
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
      "dueText": "Ongoing; there is no single date.",
      "authority": "RENAPO (Secretaría de Gobernación)",
      "consequence": "Unclear; reports say it may be requested for some procedures.",
      "sources": [
        "https://www.adn40.mx/tramites/2026-02-09/lo-que-todos-se-preguntan-en-mexico-es-realmente-obligatoria-la-curp-biometrica-para-migrantes-y-cuando-te-la-pediran/"
      ],
      "confidence": "low",
      "notes": "The source is internally inconsistent and no official RENAPO page was read. Keep as a watch item, not a dated reminder.",
      "reviewedByCounsel": false
    },
    {
      "id": "MX_XB_US_FIDEICOMISO_REPORTING",
      "country": "MX",
      "area": "cross_border",
      "title": "US reporting for Mexican accounts and bank trust: filing may require review",
      "meaning": "US persons may need to report Mexican bank accounts (FBAR if over USD 10,000 in total) and, depending on its terms, a fideicomiso. This is a home-country obligation to flag, not a Mexican one.",
      "when": {
        "all": {
          "citizenship": [
            "US"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          4,
          15
        ]
      },
      "dueText": "April 15 with your US return (FBAR has an automatic extension to October 15).",
      "authority": "IRS / FinCEN (United States)",
      "consequence": "Non-willful FBAR penalty up to USD 16,536 per violation (2026 figure as reported).",
      "sources": [
        "https://www.taxesforexpats.com/country-guides/mexico/fideicomiso-in-usa.html"
      ],
      "confidence": "medium",
      "notes": "Per Rev. Rul. 2013-14, a standard real-estate fideicomiso is not a trust for US tax purposes, so Forms 3520/3520-A are usually not required. Canadian equivalents (T1135) were not researched (low).",
      "reviewedByCounsel": false
    }
  ]
};
