/**
 * API/countries/rules/es.ts: Spain (ES). GENERATED, do not edit by hand.
 * Source: docs/research/spain.md (research date 2026-10-27), imported by
 * scripts/importCountryResearch.py. 37 rules (1 low confidence), 13 questions.
 * Every rule has reviewedByCounsel: false until a Spain partner lawyer signs it off.
 */
import type { CountryRuleset } from "./engine.ts";

export const ES_RULESET: CountryRuleset = {
  "country": "ES",
  "researchDate": "2026-10-27",
  "questions": [
    {
      "key": "residencyStatus",
      "stage": "check",
      "question": "What is your current status in Spain?",
      "type": "choice",
      "options": [
        {
          "value": "visitor",
          "label": "Visitor (no Spanish residence permit)"
        },
        {
          "value": "nonLucrative",
          "label": "Non-lucrative residence (retiree / passive income)",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        },
        {
          "value": "digitalNomad",
          "label": "Digital nomad (international teleworker)",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        },
        {
          "value": "goldenVisa",
          "label": "Golden visa (investor) permit",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        },
        {
          "value": "longTerm",
          "label": "Long-term resident",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        },
        {
          "value": "other",
          "label": "Other permit (work, family, student)",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        },
        {
          "value": "notSure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Residency rules set renewal dates and how long you can stay."
    },
    {
      "key": "permitExpiryDate",
      "stage": "check",
      "question": "When does your residence permit or TIE card expire?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "research",
      "showIf": {
        "residencyStatus": [
          "nonLucrative",
          "digitalNomad",
          "goldenVisa",
          "longTerm",
          "other"
        ]
      },
      "why": "Renewals are dated from it.",
      "help": "It is printed on the card. Skip this if you do not have it at hand."
    },
    {
      "key": "isTaxResident",
      "stage": "check",
      "question": "Do you spend more than 183 days a year in Spain, or is Spain where your main income and family are?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        },
        {
          "value": "no",
          "label": "No",
          "sets": {
            "spendsTimeInSpain": "no"
          }
        },
        {
          "value": "notSure",
          "label": "Not sure",
          "sets": {
            "spendsTimeInSpain": "yes"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Tax residents file a yearly return and some declarations that visitors do not."
    },
    {
      "key": "region",
      "stage": "check",
      "question": "Where in Spain is your home or main property?",
      "type": "choice",
      "options": [
        {
          "value": "andalucia",
          "label": "Andalusia"
        },
        {
          "value": "valencia",
          "label": "Valencian Community"
        },
        {
          "value": "cataluna",
          "label": "Catalonia"
        },
        {
          "value": "madrid",
          "label": "Madrid"
        },
        {
          "value": "baleares",
          "label": "Balearic Islands"
        },
        {
          "value": "canarias",
          "label": "Canary Islands"
        },
        {
          "value": "paisVasco_navarra",
          "label": "Basque Country or Navarra"
        },
        {
          "value": "otra",
          "label": "Another region"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Some taxes and dates are set by the region or town."
    },
    {
      "key": "ownsProperty",
      "stage": "check",
      "question": "Do you own a home, apartment or land in Spain?",
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
      "key": "rentsOutProperty",
      "stage": "check",
      "question": "Do you rent it out, even part of the year (including holiday rentals)?",
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
      "why": "Rental income usually has its own tax returns.",
      "showIf": {
        "ownsProperty": [
          "yes"
        ]
      }
    },
    {
      "key": "ownsVehicle",
      "stage": "check",
      "question": "Do you own or drive a vehicle in Spain?",
      "type": "choice",
      "options": [
        {
          "value": "spanishPlated",
          "label": "I own a Spanish-registered vehicle",
          "sets": {
            "ownsVehicle": "yes"
          }
        },
        {
          "value": "foreignLicenseOnly",
          "label": "I drive using my US or Canadian licence",
          "sets": {
            "ownsVehicle": "no",
            "drivesWithForeignLicense": "yes"
          }
        },
        {
          "value": "both",
          "label": "Both",
          "sets": {
            "ownsVehicle": "yes",
            "drivesWithForeignLicense": "yes"
          }
        },
        {
          "value": "no",
          "label": "No",
          "sets": {
            "ownsVehicle": "no",
            "drivesWithForeignLicense": "no"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Vehicles have yearly fees, inspections and insurance dates."
    },
    {
      "key": "hasCompany",
      "stage": "check",
      "question": "Do you own a Spanish company (S.L. or S.A.) or work as self-employed (autónomo) in Spain?",
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
      "why": "Companies have yearly filings, even when they do no business."
    },
    {
      "key": "hasEmployees",
      "stage": "check",
      "question": "Do you employ anyone in your home in Spain, such as a cleaner, gardener or carer?",
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
      "why": "Employers, including households with staff, have monthly payments and yearly bonuses."
    },
    {
      "key": "hasForeignAssetsOver50k",
      "stage": "check",
      "question": "Outside Spain, do you hold more than EUR 50,000 (about US$/C$ equivalent) in any one of: bank accounts, investments or retirement accounts, real estate, or cryptocurrency on an exchange?",
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
          "value": "notSure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "netWealthBand",
      "stage": "check",
      "question": "Roughly, what is your total net worth worldwide?",
      "type": "choice",
      "options": [
        {
          "value": "under2M",
          "label": "Under EUR 2 million"
        },
        {
          "value": "2to3M",
          "label": "EUR 2 to 3 million"
        },
        {
          "value": "over3M",
          "label": "Over EUR 3 million"
        },
        {
          "value": "preferNot",
          "label": "Prefer not to say"
        }
      ],
      "optional": true,
      "source": "research"
    },
    {
      "key": "lifeEvent",
      "stage": "profile",
      "question": "Has any of these happened recently, or is about to?",
      "type": "multi",
      "options": [
        {
          "value": "sale",
          "label": "Selling property in Spain"
        },
        {
          "value": "gift",
          "label": "Giving property as a gift"
        },
        {
          "value": "inheritance",
          "label": "Inheriting property in Spain"
        },
        {
          "value": "death_of_relative",
          "label": "The death of a close relative"
        },
        {
          "value": "none",
          "label": "None of these"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "hasForeignCryptoOver50k",
      "stage": "check",
      "question": "Do you hold more than EUR 50,000 in cryptocurrency on exchanges outside Spain?",
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
        "hasForeignAssetsOver50k": [
          "yes",
          "notSure"
        ]
      },
      "why": "Crypto held abroad has its own declaration, due with the foreign assets one."
    }
  ],
  "rules": [
    {
      "id": "ES_IMM_NLV_RENEWAL",
      "country": "ES",
      "area": "immigration",
      "title": "Non-lucrative residence renewal may require review",
      "meaning": "Your non-lucrative residence permit has to be renewed around its expiry date, and renewals now last two years.",
      "when": {
        "all": {
          "residencyStatus": [
            "nonLucrative"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitExpiryDate",
        "days": 90,
        "windowStartDays": -60
      },
      "dueText": "From 60 days before the permit expires until 90 days after (filing late may open a sanction procedure).",
      "authority": "Oficina de Extranjería (Ministerio de Inclusión, Seguridad Social y Migraciones; Delegación/Subdelegación del Gobierno)",
      "consequence": "Filing up to 3 months late is accepted but a sanction procedure may be opened; missing the window can leave the person without legal residence.",
      "sources": [
        "https://www.inclusion.gob.es/web/migraciones/w/renovacion-de-la-autorizacion-de-residencia-temporal-no-lucrativa",
        "https://www.costaluzlawyers.com/non-lucrative-visa-renewals-in-spain-still-2-years-not-4-clarified-under-the-2025-reform/"
      ],
      "confidence": "high",
      "notes": "RD 1155/2024 (in force 20 May 2025), art. 64. First permit 1 year, renewals 2 years. Renewal requires effective residence in Spain more than 183 days in the calendar year and sufficient means (the official page does not state the IPREM multiple). After approval, apply for the renewed TIE within 1 month.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_DNV_RENEWAL",
      "country": "ES",
      "area": "immigration",
      "title": "Digital nomad permit renewal may require review",
      "meaning": "The international teleworker (digital nomad) residence permit is granted for up to three years and must be renewed before it expires.",
      "when": {
        "all": {
          "residencyStatus": [
            "digitalNomad"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitExpiryDate",
        "days": -60
      },
      "dueText": "60 days before the expiry date on your residence card.",
      "authority": "Unidad de Grandes Empresas y Colectivos Estratégicos (UGE-CE), Ministerio de Inclusión",
      "consequence": "If not renewed in time the person may lose legal residence and the right to work remotely from Spain.",
      "sources": [
        "https://www.gestoresalicante.org/blog/wp-content/uploads/2025/08/CRITERIO-DE-GESTION-DGGM-2-2025_LEY-14-2013_DURACION-AUTORIZACIONES-DE-RES.DENCIA.pdf"
      ],
      "confidence": "medium",
      "notes": "Ley 14/2013 art. 74 quinquies. DGGM criterion 2/2025 (signed 16 July 2025): duration 'for the time requested, maximum three years'. The exact renewal filing window for UGE-CE permits was not confirmed on an official page; 60 days before expiry is used as a conservative reminder.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_TIE_APPLY",
      "country": "ES",
      "area": "immigration",
      "title": "Apply for your foreigner ID card (TIE) may require review",
      "meaning": "After arriving with a residence visa, or after a permit is granted or renewed, you must book a police appointment and apply for the physical TIE card.",
      "when": {
        "all": {
          "residencyStatus": [
            "nonLucrative",
            "digitalNomad",
            "other"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "entryOrGrantDate",
        "days": 30
      },
      "dueText": "30 days after the date you arrived or your permit was granted.",
      "authority": "Policía Nacional (Comisaría, oficina de documentación de extranjeros)",
      "consequence": "Without a current TIE it is harder to prove legal residence, travel and re-enter Spain, or complete banking and administrative steps; late applications can lead to a fine.",
      "sources": [
        "https://www.inclusion.gob.es/web/migraciones/w/renovacion-de-la-autorizacion-de-residencia-temporal-no-lucrativa",
        "https://www.pellicerheredia.com/tie-tarjeta-identidad-extranjero/"
      ],
      "confidence": "high",
      "notes": "One month from entry, grant, or the authorization taking effect. Appointment (cita previa) availability varies by province; keep proof of attempts.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_TIE_RENEWAL",
      "country": "ES",
      "area": "immigration",
      "title": "Renew a long-term TIE card may require review",
      "meaning": "Long-term residents keep their status but the physical card still expires and must be renewed.",
      "when": {
        "all": {
          "residencyStatus": [
            "longTerm"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "cardExpiryDate",
        "days": 90,
        "windowStartDays": -60
      },
      "dueText": "From 60 days before the card expires until 90 days after.",
      "authority": "Policía Nacional / Oficina de Extranjería",
      "consequence": "An expired card does not end long-term status, but late renewal can be sanctioned and makes travel and paperwork harder.",
      "sources": [
        "https://www.inclusion.gob.es/en/web/migraciones/w/49.-autorizacion-de-residencia-de-larga-duracion-nacional"
      ],
      "confidence": "high",
      "notes": "Fact sheet 49 (May 2025): renew in the 2 months before expiry, 3-month grace after. Card renewal intervals depend on age (every 5 years until age 30 on the official text, then every 10 years) - confirm per case.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_LONGTERM",
      "country": "ES",
      "area": "immigration",
      "title": "Long-term residence eligibility may require review",
      "meaning": "After five years of continuous legal residence you can usually apply for long-term residence, which ends the cycle of temporary renewals.",
      "when": {
        "all": {
          "residencyStatus": [
            "nonLucrative",
            "digitalNomad",
            "goldenVisa",
            "other"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "firstResidenceDate",
        "years": 5
      },
      "dueText": "5 years after the date your first residence permit started.",
      "authority": "Oficina de Extranjería",
      "consequence": "Not applying keeps the person on temporary permits with renewal risk; long absences can break the 5-year count.",
      "sources": [
        "https://www.inclusion.gob.es/en/web/migraciones/w/49.-autorizacion-de-residencia-de-larga-duracion-nacional",
        "https://www.inclusion.gob.es/es/web/migraciones/w/50.-autorizacion-de-residencia-de-larga-duracion-ue"
      ],
      "confidence": "high",
      "notes": "Absences allowed: up to 6 continuous months, max 10 months total in the 5 years (18 months for work reasons). File within 2 months before the current permit expires. Time on some statuses (e.g. student) may count partially - confirm.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_PADRON_RENEW",
      "country": "ES",
      "area": "immigration",
      "title": "Town hall registration (padrón) renewal may require review",
      "meaning": "You register your address with the town hall (empadronamiento); non-EU residents without long-term status must renew it every two years or it is cancelled.",
      "when": {
        "all": {
          "residencyStatus": [
            "nonLucrative",
            "digitalNomad",
            "goldenVisa",
            "other"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "padronRegistrationDate",
        "years": 2
      },
      "dueText": "2 years after the date you registered at the town hall.",
      "authority": "Ayuntamiento (town hall)",
      "consequence": "The town hall can remove the registration for expiry (baja por caducidad) without a prior hearing; the padrón certificate is needed for many procedures, including residence renewals.",
      "sources": [
        "https://www.alicante.es/es/node/14309"
      ],
      "confidence": "high",
      "notes": "National rule (Ley 7/1985 art. 16 as amended, and 2005 resolution) applied by every municipality; the Alicante page is one municipal example. Renewal method varies by town.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_SCHENGEN",
      "country": "ES",
      "area": "immigration",
      "title": "90/180-day visitor limit may require review",
      "meaning": "US and Canadian visitors without a residence permit can stay in the Schengen area up to 90 days in any 180-day period, now tracked electronically.",
      "when": {
        "all": {
          "residencyStatus": [
            "visitor"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Rolling 90 days in any 180-day window.",
      "authority": "Policía Nacional (border control); EU Entry/Exit System",
      "consequence": "Overstays can lead to fines, entry bans and problems with later visa applications.",
      "sources": [
        "https://www.eeas.europa.eu/delegations/united-states-america/travelling-europe-etias_en"
      ],
      "confidence": "high",
      "notes": "EES started 12 Oct 2025 (full by 10 Apr 2026). ETIAS travel authorisation scheduled for Q4 2026; exact start date not confirmed (medium). Owning property in Spain does not extend the 90 days.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_GOLDEN_VISA",
      "country": "ES",
      "area": "immigration",
      "title": "Former golden visa holders: renewal path may require review",
      "meaning": "Spain abolished investor (golden) visas from 3 April 2025; existing holders should check how their permit can be renewed or changed.",
      "when": {
        "all": {
          "residencyStatus": [
            "goldenVisa"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitExpiryDate",
        "days": -90
      },
      "dueText": "90 days before the expiry date on your residence card.",
      "authority": "UGE-CE, Ministerio de Inclusión",
      "consequence": "Uncertain without advice; the person could lose residence if no valid route is used.",
      "sources": [
        "https://www.lamoncloa.gob.es/serviciosdeprensa/notasprensa/vivienda-agenda-urbana/Paginas/2025/020425-fin-golden-visa.aspx"
      ],
      "confidence": "low",
      "notes": "Organic Law 1/2025 ended the program on 3 April 2025 (confirmed). Transitional rules for renewals of existing permits were NOT confirmed in this research; law-firm sources mention transitional provisions. Route to a lawyer.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_IMM_NIE",
      "country": "ES",
      "area": "immigration",
      "title": "Foreigner identity number (NIE) may require review",
      "meaning": "The NIE is the number Spain uses to identify foreigners for tax, property, banking and company matters; you need it before most transactions.",
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
            "isTaxResident": [
              "yes"
            ]
          },
          {
            "residencyStatus": [
              "digitalNomad",
              "goldenVisa",
              "longTerm",
              "nonLucrative",
              "notSure",
              "other"
            ]
          }
        ]
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Before buying property, opening a company or filing taxes.",
      "authority": "Policía Nacional; Spanish consulates abroad",
      "consequence": "Without an NIE a notary deed, tax filing or company registration cannot be completed.",
      "sources": [
        "https://www.pellicerheredia.com/tie-tarjeta-identidad-extranjero/"
      ],
      "confidence": "medium",
      "notes": "Not a recurring deadline. The NIE stays the same for life; the TIE card that shows it expires. Official Policía Nacional page not opened in this session.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_VEH_LICENSE",
      "country": "ES",
      "area": "vehicle",
      "title": "US or Canadian driving licence stops being valid may require review",
      "meaning": "Spain has no licence-exchange agreement with the US or Canada, so after six months of residence you need a Spanish licence to keep driving.",
      "when": {
        "all": {
          "drivesWithForeignLicense": [
            "yes"
          ],
          "residencyStatus": [
            "nonLucrative",
            "digitalNomad",
            "longTerm",
            "goldenVisa",
            "other"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "normalResidenceStartDate",
        "months": 6
      },
      "dueText": "6 months after the date you became resident.",
      "authority": "Dirección General de Tráfico (DGT)",
      "consequence": "Driving on the foreign licence after the six-month limit is treated as driving without a valid licence; insurance cover may also be affected.",
      "sources": [
        "https://sede.dgt.gob.es/es/permisos-de-conducir/canjes-de-permisos/canjes-de-permisos-extranjeros/canjes-de-paises-sin-convenio/index.html",
        "https://www.dgt.es/nuestros-servicios/permisos-de-conducir/permisos-extranjeros-y-de-fuerzas-y-cuerpos-de-seguridad/canjes-de-permisos/paises-con-convenio-de-canjes/index.html"
      ],
      "confidence": "high",
      "notes": "Normal residence = living in Spain at least 185 days per calendar year (DGT). Neither the US nor Canada (nor any state/province) is on the 33-country agreement list. Exchange without tests applies only to qualifying professional drivers. Visitors may drive on a US/Canadian licence; an International Driving Permit is commonly recommended (not verified here).",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_PROP_IBI",
      "country": "ES",
      "area": "property",
      "title": "Annual property tax (IBI) may require review",
      "meaning": "Every property owner pays an annual municipal property tax (IBI) based on the cadastral value, in a payment window set by the town hall.",
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
      "dueText": "Once a year in a payment period set by your town hall (for example September 1 to November 30 in Las Rozas, Madrid).",
      "authority": "Ayuntamiento (or provincial tax collection agency, e.g. SUMA, diputación)",
      "consequence": "Unpaid IBI moves to enforced collection with surcharges and interest, and the debt follows the property (affects a sale).",
      "sources": [
        "https://www.lasrozas.es/sites/default/files/CONTENIDOS/NOTAS%20DE%20PRENSA/2026/01/29/2026-01-29%20CALENDARIO%20FISCAL%202026%20LAS%20%20ROZAS.pdf"
      ],
      "confidence": "high",
      "notes": "Owner on 1 January is liable for the whole year. Windows, instalment plans and direct-debit discounts vary by municipality (Las Rozas offers 2/5/9 instalments with 5% discount if requested by 31 Dec of prior year). Store the member's municipality and its calendar.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_PROP_WASTE",
      "country": "ES",
      "area": "property",
      "title": "Municipal waste collection fee (basura) may require review",
      "meaning": "Many towns charge a separate annual fee for rubbish collection, billed with IBI, the water bill, or on its own.",
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
      "dueText": "Once a year in a period set by your town hall (for example June 1 to July 31 in Las Rozas).",
      "authority": "Ayuntamiento",
      "consequence": "Unpaid fees go to enforced collection with surcharges.",
      "sources": [
        "https://www.lasrozas.es/sites/default/files/CONTENIDOS/NOTAS%20DE%20PRENSA/2026/01/29/2026-01-29%20CALENDARIO%20FISCAL%202026%20LAS%20%20ROZAS.pdf"
      ],
      "confidence": "medium",
      "notes": "Ley 7/2022 requires municipalities to set a waste fee, so more towns now charge it separately; amount and timing vary widely (the national law was not opened in this session).",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_PROP_NONRES_IMPUTED",
      "country": "ES",
      "area": "property",
      "title": "Non-resident owner annual tax on a home not rented out (Modelo 210) may require review",
      "meaning": "Non-residents who own a home in Spain that is not rented pay a yearly tax on a deemed (imputed) income, even if the home produces no money.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "isTaxResident": [
            "no"
          ],
          "rentsOutProperty": [
            "no"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              4,
              1
            ],
            "end": [
              12,
              31
            ]
          }
        ]
      },
      "dueText": "2025 income: by December 31, 2026. From 2026 income: April 1 to December 31 of the following year (direct debit until December 23).",
      "authority": "Agencia Estatal de Administración Tributaria (AEAT)",
      "consequence": "Late filing brings surcharges and interest; unpaid tax can become a charge that complicates selling.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/no-residentes/irnr-sin-establecimiento-permanente/declaracion-irnr-sin-establecimiento-permanente/modelo-plazo-declaracion.html",
        "https://sede.agenciatributaria.gob.es/Sede/eu_es/todas-gestiones/impuestos-tasas/impuesto-sobre-renta-no-residentes/modelo-210-irnr______a-no-residentes-permanente_/nota-modificaciones-plazos-presentacion-modelo-210.html"
      ],
      "confidence": "high",
      "notes": "Changed by Orden HAC/623/2026 (BOE 23 Jun 2026). One return per owner per property (spouses file separately). For a member owning since 2025, the 2025 return is due by 31 Dec 2026 - two months from today.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_PROP_NONRES_RENTAL",
      "country": "ES",
      "area": "property",
      "title": "Non-resident rental income tax (Modelo 210) may require review",
      "meaning": "Non-residents who rent out Spanish property must declare the rental income to the Spanish tax agency.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "isTaxResident": [
            "no"
          ],
          "rentsOutProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              4,
              1
            ],
            "end": [
              4,
              20
            ]
          }
        ]
      },
      "dueText": "Rent from October 2026 on: April 1 to April 20 of the following year (direct debit April 1 to 15).",
      "authority": "AEAT",
      "consequence": "Late filing brings surcharges and interest; deductibility of expenses depends on residence country (EU/EEA vs US/Canada).",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/no-residentes/irnr-sin-establecimiento-permanente/declaracion-irnr-sin-establecimiento-permanente/modelo-plazo-declaracion.html",
        "https://sede.agenciatributaria.gob.es/Sede/eu_es/todas-gestiones/impuestos-tasas/impuesto-sobre-renta-no-residentes/modelo-210-irnr______a-no-residentes-permanente_/nota-modificaciones-plazos-presentacion-modelo-210.html"
      ],
      "confidence": "high",
      "notes": "New 2026 annex for deductible expenses on returns filed from 1 Jan 2027. Tourist rentals also face regional licensing and registration rules (not researched here). US/Canada residents generally cannot deduct expenses the way EU/EEA residents can - confirm with a tax adviser.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_PROP_COMMUNITY",
      "country": "ES",
      "area": "property",
      "title": "Community of owners fees and annual meeting may require review",
      "meaning": "If your property is in a building or complex, you must pay your share of common costs and the owners meet at least once a year to approve the budget.",
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
      "dueText": "Fees as set by the community (often monthly or quarterly); general meeting at least once a year.",
      "authority": "Comunidad de propietarios (Ley de Propiedad Horizontal)",
      "consequence": "The community can claim unpaid fees in court and the debt can attach to the property.",
      "sources": [
        "https://www.boe.es/buscar/act.php?id=BOE-A-1960-10906"
      ],
      "confidence": "high",
      "notes": "LPH arts. 9.1.e and 16.1. Catalonia has its own civil-code rules for horizontal property. Not applicable to stand-alone houses outside an urbanization.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_PROP_PLUSVALIA",
      "country": "ES",
      "area": "property",
      "title": "Municipal land value tax on sale or inheritance (plusvalía) may require review",
      "meaning": "When property is sold, gifted or inherited, the town hall charges a tax on the increase in the land's value, with a short filing deadline.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "lifeEvent": [
            "sale",
            "gift",
            "inheritance"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "sale, gift or inheritance"
      },
      "dueText": "30 working days after a sale or gift; 6 months after a death for an inheritance (6 more if asked for in time).",
      "authority": "Ayuntamiento",
      "consequence": "Late filing brings surcharges and interest.",
      "sources": [
        "https://Www.Lasrozas.es/sites/default/files/inline-files/INFORMACION%20IIVTNU%2017-02-2022.pdf"
      ],
      "confidence": "medium",
      "notes": "IIVTNU. Deadlines come from the national local-finance law (TRLRHL art. 110) but whether it is a declaration or self-assessment depends on the municipal ordinance. Since RDL 26/2021 the taxpayer can choose the real-gain method; no tax if there is no real gain. In a sale, the seller normally pays.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_PROP_NONRES_SALE",
      "country": "ES",
      "area": "property",
      "title": "Non-resident property sale: capital gains return (Modelo 210) may require review",
      "meaning": "When a non-resident sells Spanish property, the buyer withholds part of the price and the seller must file a capital gains return afterwards.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "isTaxResident": [
            "no"
          ],
          "lifeEvent": [
            "sale"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "saleDate",
        "months": 4,
        "windowStartDays": 30
      },
      "dueText": "In months 2 to 4 after the sale.",
      "authority": "AEAT",
      "consequence": "Without the return the seller cannot recover over-withheld tax and may face surcharges if more is due.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/no-residentes/irnr-sin-establecimiento-permanente/declaracion-irnr-sin-establecimiento-permanente/modelo-plazo-declaracion.html"
      ],
      "confidence": "high",
      "notes": "Deadline confirmed on AEAT. The buyer's 3% withholding (Modelo 211) is standard but was not re-confirmed on an official page in this session (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_TAX_RESIDENCY",
      "country": "ES",
      "area": "tax",
      "title": "Spanish tax residency (183-day rule) may require review",
      "meaning": "You are a Spanish tax resident, taxed on worldwide income, if you spend more than 183 days in Spain in a calendar year or your main economic interests are here.",
      "when": {
        "all": {
          "spendsTimeInSpain": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Assessed per calendar year (01-01 to 12-31)",
      "authority": "AEAT",
      "consequence": "Becoming resident brings IRPF, Modelo 720/721 and possibly wealth tax duties; treaty tie-breakers with the US or Canada may apply.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/irpf-2024/c02-irpf-cuestiones-generales/sujecion-irpf-aspectos-personales/residencia-habitual-territorio-espanol.html"
      ],
      "confidence": "high",
      "notes": "IRPF Law art. 9: >183 days (sporadic absences count unless foreign tax residence is proven), or centre of economic interests in Spain; presumption if non-separated spouse and dependent minor children live in Spain. Non-lucrative and digital nomad holders usually become tax resident. Special 'Beckham' regime (Modelo 151) exists for some inbound workers - not researched here.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_TAX_IRPF",
      "country": "ES",
      "area": "tax",
      "title": "Annual personal income tax return (IRPF) may require review",
      "meaning": "Spanish tax residents file one income tax return each spring covering the previous calendar year's worldwide income.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ]
        },
        "unless": {
          "region": [
            "paisVasco_navarra"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              4,
              8
            ],
            "end": [
              6,
              30
            ]
          }
        ]
      },
      "dueText": "Early April to June 30 (2026 campaign: April 8 to June 30; direct debit by June 25).",
      "authority": "AEAT (Haciendas Forales in the Basque Country and Navarra)",
      "consequence": "Late filing brings surcharges (higher the later it is) and interest; failure to file can lead to penalties.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/todas-noticias/2026/abril/8/inicio-campana-renta-patrimonio-2025.html",
        "https://sede.agenciatributaria.gob.es/Sede/ayuda/calendario-contribuyente/calendario-contribuyente-2026/calendario-anual/junio/hasta-30-junio.html"
      ],
      "confidence": "high",
      "notes": "Filing thresholds exist; not everyone must file. US citizens also keep filing US returns; the US-Spain and Canada-Spain treaties address double taxation. Start date shifts slightly each year.",
      "reviewedByCounsel": false,
      "rollWeekend": "next",
      "estimatedFromYear": 2026
    },
    {
      "id": "ES_TAX_720",
      "country": "ES",
      "area": "tax",
      "title": "Foreign assets declaration (Modelo 720) may require review",
      "meaning": "Spanish tax residents report bank accounts, investments and real estate held outside Spain when a category exceeds EUR 50,000.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ],
          "hasForeignAssetsOver50k": [
            "yes"
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
              3,
              31
            ]
          }
        ]
      },
      "dueText": "January 1 to March 31 each year.",
      "authority": "AEAT",
      "consequence": "Since Law 5/2022 the special fines and 150% penalty no longer apply, but general tax-law penalties for late or missing information returns still can.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/todas-gestiones/impuestos-tasas/declaraciones-informativas/modelo-720-decla_____sobre-bienes-derechos-extranjero_/preguntas-frecuentes/forma-calcular-limite-que-obliga-declarar.html",
        "https://sede.agenciatributaria.gob.es/Sede/todas-gestiones/impuestos-tasas/declaraciones-informativas/modelo-720-decla_____sobre-bienes-derechos-extranjero_/preguntas-frecuentes/frecuencia-presentacion-declaracion.html",
        "https://www.garrigues.com/es_ES/noticia/modelo-720-publicada-regulacion-elimina-regimen-sancionador"
      ],
      "confidence": "high",
      "notes": "Three blocks (accounts; securities/insurance; real estate), EUR 50,000 per block at 31 Dec (or average Q4 balance for accounts). After the first filing, re-file only if a block grows by more than EUR 20,000, or on cancellation of an asset. Very relevant to US/Canadian retirement and brokerage accounts. Exact general-penalty amounts not confirmed here.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_TAX_721",
      "country": "ES",
      "area": "tax",
      "title": "Crypto held abroad declaration (Modelo 721) may require review",
      "meaning": "Spanish tax residents report cryptocurrency held with foreign custodians when the total exceeds EUR 50,000 on 31 December.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ],
          "hasForeignCryptoOver50k": [
            "yes"
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
              3,
              31
            ]
          }
        ]
      },
      "dueText": "January 1 to March 31 each year.",
      "authority": "AEAT",
      "consequence": "General tax-law penalties for late or missing information returns.",
      "sources": [
        "https://www.ocu.org/inversiones/invertir/criptomonedas/articulos/2026/02/modelo-721-paradeclarar-las-criptomonedas-en-el-extranjero",
        "https://sede.agenciatributaria.gob.es/static_files/Sede/Procedimiento_ayuda/GI55/Anexo721.pdf"
      ],
      "confidence": "medium",
      "notes": "Same deadline and electronic filing as Modelo 720 (OCU, Feb 2026). Self-custodied crypto (own wallet) is generally outside 721 - confirm. Re-filing rule after the first year (EUR 20,000 increase) not confirmed on an official page. EU DAC8 crypto reporting started 2026 for platforms; effect on 721 not researched.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_TAX_WEALTH",
      "country": "ES",
      "area": "tax",
      "title": "Wealth tax return (Modelo 714) may require review",
      "meaning": "Wealth tax is due on net assets above an allowance; residents report worldwide assets and non-residents report Spanish assets only.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "netWealthBand": [
              "2to3M"
            ]
          },
          {
            "netWealthBand": [
              "over3M"
            ]
          }
        ],
        "unless": {
          "region": [
            "paisVasco_navarra"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              4,
              8
            ],
            "end": [
              6,
              30
            ]
          }
        ]
      },
      "dueText": "Same window as the income tax return, to June 30 (direct debit to June 25).",
      "authority": "AEAT (managed and partly set by the autonomous communities)",
      "consequence": "Late filing brings surcharges and interest.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/static_files/Sede/Biblioteca/Manual/Practicos/Patrimonio/Patrimonio-2024/ManualPatrimonio2024_es_es.pdf",
        "https://sede.agenciatributaria.gob.es/Sede/todas-noticias/2026/abril/8/inicio-campana-renta-patrimonio-2025.html"
      ],
      "confidence": "high",
      "notes": "Must file if tax is payable (after the EUR 700,000 general allowance, or regional figure) or if gross assets exceed EUR 2,000,000. Strong regional variation (e.g. some regions grant 100% relief). Non-residents may apply the rules of the region where most of their Spanish assets are.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_TAX_SOLIDARITY",
      "country": "ES",
      "area": "tax",
      "title": "Solidarity tax on large fortunes (Modelo 718) may require review",
      "meaning": "A national tax applies to net wealth above EUR 3 million, mainly catching people in regions that reduce or waive wealth tax.",
      "when": {
        "all": {
          "netWealthBand": [
            "over3M"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              7,
              1
            ],
            "end": [
              7,
              31
            ]
          }
        ]
      },
      "dueText": "July 1 to July 31 each year.",
      "authority": "AEAT",
      "consequence": "Late filing brings surcharges and interest.",
      "sources": [
        "https://www.boe.es/eli/es/o/2023/06/09/hfp587/con",
        "https://sede.agenciatributaria.gob.es/Sede/en_gb/todas-noticias/2026/junio/29/modificacion-impuesto-temporal-solidaridad-grandes-fortunas.html"
      ],
      "confidence": "high",
      "notes": "Orden HFP/587/2023 art. 3: 1-31 July of the following year (direct debit 1-26 July). Orden HAC/652/2026 updated the form for tax year 2025. Wealth tax paid is credited against it. Its continuation for tax year 2026 was not confirmed (medium).",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_TAX_INHERITANCE",
      "country": "ES",
      "area": "estate",
      "title": "Inheritance tax return after a death may require review",
      "meaning": "Heirs receiving Spanish assets, or Spanish-resident heirs, must file inheritance tax within six months of the death.",
      "when": {
        "all": {
          "lifeEvent": [
            "death_of_relative",
            "inheritance"
          ]
        },
        "anyOf": [
          {
            "ownsProperty": [
              "yes"
            ]
          },
          {
            "isTaxResident": [
              "yes"
            ]
          }
        ]
      },
      "due": {
        "kind": "relative",
        "anchor": "dateOfDeath",
        "months": 6
      },
      "dueText": "6 months after the date of death.",
      "authority": "Regional tax agency, or AEAT (Oficina Nacional de Gestión Tributaria) for non-residents",
      "consequence": "Late filing brings surcharges and interest; property cannot be registered to heirs until tax is settled.",
      "sources": [
        "https://www3.agenciatributaria.gob.es/static_files/Sede/Procedimiento_ayuda/G702/Instrucciones_650_No_res_V06.pdf",
        "https://administracion.gob.es/gl/tu-espacio-europeo/derechos-obligaciones/ciudadanos/familia/sucesiones/normas-fiscales"
      ],
      "confidence": "high",
      "notes": "Rates and allowances vary greatly by region. Non-residents may opt for a region's rules (DA 2a Ley 29/1987). Heirs resident outside the EU/EEA must appoint a Spanish-resident representative. An extension can be requested; its exact conditions were not confirmed here. Municipal plusvalía has the same 6-month deadline.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_CO_ACCOUNTS_APPROVAL",
      "country": "ES",
      "area": "corporate",
      "title": "Shareholders approve annual accounts may require review",
      "meaning": "A Spanish S.L. must hold a shareholders' meeting to approve the prior year's accounts within six months of year-end.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "fiscalYearEnd",
        "months": 6,
        "fallback": [
          6,
          30
        ]
      },
      "dueText": "Within 6 months of the year-end (June 30 for a calendar year).",
      "authority": "Company (junta general); Registro Mercantil",
      "consequence": "Missing it delays the accounts deposit and exposes directors to liability.",
      "sources": [
        "https://www.legalitas.com/actualidad/deposito-de-cuentas-anuales-los-6-puntos-tener-en-cuenta"
      ],
      "confidence": "high",
      "notes": "Ley de Sociedades de Capital art. 164. Directors must prepare (formulate) the accounts within 3 months of year-end (art. 253; not re-confirmed on an official page here).",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_CO_ACCOUNTS_DEPOSIT",
      "country": "ES",
      "area": "corporate",
      "title": "Deposit annual accounts and beneficial owner form may require review",
      "meaning": "After approval, the company files its accounts with the Mercantile Registry, together with the beneficial ownership declaration.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "accountsApprovalDate",
        "months": 1,
        "fallback": [
          7,
          30
        ]
      },
      "dueText": "Within 1 month of approval (July 30 if approved June 30).",
      "authority": "Registro Mercantil (Colegio de Registradores)",
      "consequence": "If not deposited within a year of year-end, the registry closes the company's sheet to most new filings; ICAC fines of EUR 1,200 to 60,000 are possible; directors may be liable.",
      "sources": [
        "https://www.legalitas.com/actualidad/deposito-de-cuentas-anuales-los-6-puntos-tener-en-cuenta"
      ],
      "confidence": "high",
      "notes": "Beneficial owner (titular real) form has been required with the deposit for years closed after 1 Jan 2017. Official registradores.org page not opened in this session.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_CO_CIT_200",
      "country": "ES",
      "area": "corporate",
      "title": "Corporate income tax return (Modelo 200) may require review",
      "meaning": "Companies file their annual corporate tax return in July for a calendar-year accounting period.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              7,
              1
            ],
            "end": [
              7,
              25
            ]
          }
        ]
      },
      "dueText": "July 1 to July 25 each year.",
      "authority": "AEAT",
      "consequence": "Late filing brings surcharges, interest and possible penalties.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-sociedades-2024/capitulo-01-cuestiones-generales/presentacion-declaracion-impuesto-sobre-sociedades/plazo-presentar-declaracion.html"
      ],
      "confidence": "high",
      "notes": "Rule: 25 calendar days after the 6 months following the end of the tax period (LIS art. 124.1). Instalment payments (Modelo 202) in April, October and December may also apply (not researched).",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_CO_VAT_303",
      "country": "ES",
      "area": "corporate",
      "title": "Quarterly VAT return (Modelo 303) may require review",
      "meaning": "Businesses that charge VAT file a return each quarter and an annual summary in January.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              4,
              1
            ],
            "end": [
              4,
              20
            ]
          },
          {
            "start": [
              7,
              1
            ],
            "end": [
              7,
              20
            ]
          },
          {
            "start": [
              10,
              1
            ],
            "end": [
              10,
              20
            ]
          },
          {
            "start": [
              1,
              1
            ],
            "end": [
              1,
              30
            ]
          }
        ]
      },
      "dueText": "April 1 to 20, July 1 to 20, October 1 to 20 and January 1 to 30; the yearly summary (Modelo 390) by January 30.",
      "authority": "AEAT",
      "consequence": "Late filing brings surcharges and interest.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2025/capitulo-08-gestion-iva/autoliquidaciones-iva/plazos-presentacion.html"
      ],
      "confidence": "high",
      "notes": "Large companies file monthly. Canary Islands use IGIC (regional tax) instead of VAT; Ceuta and Melilla use IPSI.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_CO_WITHHOLDING",
      "country": "ES",
      "area": "corporate",
      "title": "Quarterly withholding returns (Modelos 111 and 115) may require review",
      "meaning": "Companies that pay salaries, professionals or office rent withhold income tax and pay it over each quarter.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "windows",
        "windows": [
          {
            "start": [
              4,
              1
            ],
            "end": [
              4,
              20
            ]
          },
          {
            "start": [
              7,
              1
            ],
            "end": [
              7,
              20
            ]
          },
          {
            "start": [
              10,
              1
            ],
            "end": [
              10,
              20
            ]
          },
          {
            "start": [
              1,
              1
            ],
            "end": [
              1,
              20
            ]
          }
        ]
      },
      "dueText": "April 1 to 20, July 1 to 20, October 1 to 20 and January 1 to 20.",
      "authority": "AEAT",
      "consequence": "Late payment brings surcharges and interest.",
      "sources": [
        "https://sede.agenciatributaria.gob.es/Sede/ayuda/calendario-contribuyente/calendario-contribuyente-2026/calendario-anual/junio/hasta-30-junio.html"
      ],
      "confidence": "medium",
      "notes": "Windows match the usual AEAT quarterly calendar but were not confirmed on a model-specific official page in this session. Annual summaries (190, 180) are due in January.",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "ES_VEH_ITV",
      "country": "ES",
      "area": "vehicle",
      "title": "Vehicle roadworthiness inspection (ITV) may require review",
      "meaning": "Cars registered in Spain must pass a periodic technical inspection (ITV).",
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
      "dueText": "First at 4 years, then every 2 years, then every year once the car is over 10 years old.",
      "authority": "DGT; regional ITV stations",
      "consequence": "Driving without a valid ITV can be fined and can complicate insurance claims.",
      "sources": [
        "https://administracion.gob.es/pag_Home/Tu-espacio-europeo/derechos-obligaciones/ciudadanos/vehiculos/itv.html"
      ],
      "confidence": "high",
      "notes": "Passenger cars (turismos) for private use. Schedules differ for motorcycles, vans and commercial vehicles. Rumours of 6-monthly ITV for older cars in 2026 were reported as false by the press.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_VEH_IVTM",
      "country": "ES",
      "area": "vehicle",
      "title": "Annual vehicle tax (IVTM) may require review",
      "meaning": "The town hall where the car is registered charges an annual road tax, payable in a set window.",
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
      "dueText": "Once a year in a period set by your town hall (for example April 1 to June 1 in Las Rozas).",
      "authority": "Ayuntamiento",
      "consequence": "Unpaid tax moves to enforced collection; DGT procedures for the vehicle (e.g. transfer) can be blocked.",
      "sources": [
        "https://www.lasrozas.es/sites/default/files/CONTENIDOS/NOTAS%20DE%20PRENSA/2026/01/29/2026-01-29%20CALENDARIO%20FISCAL%202026%20LAS%20%20ROZAS.pdf"
      ],
      "confidence": "medium",
      "notes": "Also called impuesto de circulación. The owner on 1 January pays for the year. Dates and rates vary by municipality.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_VEH_INSURANCE",
      "country": "ES",
      "area": "vehicle",
      "title": "Compulsory motor insurance renewal may require review",
      "meaning": "Every vehicle normally kept in Spain must carry at least third-party liability insurance, even if it is not being driven.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "policyRenewalDate",
        "days": -30
      },
      "dueText": "30 days before the renewal date of your policy.",
      "authority": "DGT; Consorcio de Compensación de Seguros; Ministerio de Economía (DGSFP)",
      "consequence": "Fines of EUR 601 to 3,005, a ban on driving the vehicle and possible impoundment.",
      "sources": [
        "https://www.boe.es/buscar/act.php?id=BOE-A-2004-18911"
      ],
      "confidence": "high",
      "notes": "RDL 8/2004 arts. 2.1 and 3.1.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_LAB_DOMESTIC_REGISTER",
      "country": "ES",
      "area": "employment",
      "title": "Register a household employee with Social Security may require review",
      "meaning": "If you employ a cleaner, carer or other household worker, you must register them with Social Security before they start working.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "before the first day of work"
      },
      "dueText": "Before the first day of work.",
      "authority": "Tesorería General de la Seguridad Social (TGSS), Sistema Especial para Empleados de Hogar",
      "consequence": "Unregistered employment can bring Social Security fines, back contributions and liability for accidents.",
      "sources": [
        "https://www.ocu.org/inversiones/fiscalidad-y-derechos/seguridad-social/analisis/empleados-del-hogar-contrato-salario-seguridad-social"
      ],
      "confidence": "high",
      "notes": "First-time employers need an employer account code (CCC) via form TA6-0138 Hogar. The employer is solely responsible for registration, contributions and termination. Unemployment contributions apply since Oct 2022. Official seg-social.es page not opened in this session.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_LAB_DOMESTIC_CONTRIB",
      "country": "ES",
      "area": "employment",
      "title": "Monthly Social Security contributions for household staff may require review",
      "meaning": "The employer pays Social Security contributions every month for a registered household worker.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Monthly (normally by direct debit by TGSS)",
      "authority": "TGSS",
      "consequence": "Late payment brings surcharges.",
      "sources": [
        "https://www.ocu.org/inversiones/fiscalidad-y-derechos/seguridad-social/analisis/empleados-del-hogar-contrato-salario-seguridad-social"
      ],
      "confidence": "medium",
      "notes": "Exact debit timing and 2026 contribution brackets not confirmed in this session. Wages must respect the national minimum wage (SMI); the 2026 figure was not confirmed here.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_LAB_DOMESTIC_EXTRAPAY",
      "country": "ES",
      "area": "employment",
      "title": "Two extra payments a year for household staff may require review",
      "meaning": "Household workers are entitled to two extra payments a year, usually paid at the end of each half-year unless agreed otherwise.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            6,
            30
          ],
          [
            12,
            31
          ]
        ]
      },
      "dueText": "June 30 and December 31, unless agreed otherwise.",
      "authority": "Employment relationship (RD 1620/2011)",
      "consequence": "Unpaid amounts can be claimed by the worker.",
      "sources": [
        "https://www.supercontable.com/informacion/laboral/Art.8.Real_Decreto_1620-2011-_14_noviembre-_regula_.html"
      ],
      "confidence": "high",
      "notes": "RD 1620/2011 art. 8.4. Parties may agree to prorate them into monthly pay. Amount must ensure at least the annual minimum wage in cash.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_LAB_DOMESTIC_RISK",
      "country": "ES",
      "area": "employment",
      "title": "Household workplace risk assessment may require review",
      "meaning": "Since November 2025 employers of household workers must assess workplace risks in the home and give the worker a written copy of the measures.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Before work starts; update when conditions change or after an injury; enforceable since 2025-11-14.",
      "authority": "Inspección de Trabajo y Seguridad Social",
      "consequence": "Labour inspectorate sanctions are possible.",
      "sources": [
        "https://www.boe.es/boe/dias/2024/09/11/pdfs/BOE-A-2024-18182.pdf",
        "https://eventos.asepeyo.es/wp-content/uploads/2025/10/Preguntas-y-Respuestas-webinar-Aplicacion-del-reglamento-de-prevencion-para-empleadas-del-hogar_-Guia-practica-para-asesorias.pdf"
      ],
      "confidence": "medium",
      "notes": "RD 893/2024. A free official tool (Prevención10) launched 14 May 2025; obligations enforceable six months later (date from a mutual-insurer Q&A, not an official page). Medical check obligations depend on further rules.",
      "reviewedByCounsel": false
    },
    {
      "id": "ES_EST_WILL",
      "country": "ES",
      "area": "estate",
      "title": "Spanish will for Spanish assets may require review",
      "meaning": "Many foreign owners make a Spanish will before a notary covering their Spanish assets, which makes inheritance faster for their heirs.",
      "when": {
        "all": {},
        "anyOf": [
          {
            "ownsProperty": [
              "yes"
            ]
          },
          {
            "isTaxResident": [
              "yes"
            ]
          }
        ]
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Review after marriage, divorce, birth, death, or buying/selling property.",
      "authority": "Notario; Registro General de Actos de Última Voluntad (Ministerio de Justicia)",
      "consequence": "Without a Spanish will, heirs must have a foreign will recognised (apostille, translation) or go through intestate procedures, adding time and cost.",
      "sources": [
        "https://www.mjusticia.gob.es/es/ciudadania/tramites/certificado-actos-ultima",
        "https://www.notariado.org/portal/elige-a-tu-notario-orden"
      ],
      "confidence": "medium",
      "notes": "Not a legal obligation; a recommendation. Notarial wills are recorded in the Registry of Last Wills; heirs need its certificate. EU Succession Regulation 650/2012 lets a person choose the law of their nationality - US/Canadian specifics (state law, community property) need lawyer review. Not confirmed on an official page here.",
      "reviewedByCounsel": false
    }
  ]
};
