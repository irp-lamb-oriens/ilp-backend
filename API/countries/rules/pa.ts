/**
 * API/countries/rules/pa.ts: Panama (PA). GENERATED, do not edit by hand.
 * Source: docs/research/panama.md (research date 2026-10-27), imported by
 * scripts/importCountryResearch.py. 33 rules (3 low confidence), 18 questions.
 * Every rule has reviewedByCounsel: false until a Panama partner lawyer signs it off.
 */
import type { CountryRuleset } from "./engine.ts";

export const PA_RULESET: CountryRuleset = {
  "country": "PA",
  "researchDate": "2026-10-27",
  "questions": [
    {
      "key": "residencyStatus",
      "stage": "check",
      "question": "What is your current status in Panama?",
      "type": "choice",
      "options": [
        {
          "value": "not_living_there",
          "label": "I don't live there (I own assets only)"
        },
        {
          "value": "tourist",
          "label": "Visiting as a tourist"
        },
        {
          "value": "remote_worker_visa",
          "label": "Remote-worker (short-stay) visa"
        },
        {
          "value": "application_pending",
          "label": "Residency application in process"
        },
        {
          "value": "provisional_resident",
          "label": "Provisional / temporary resident"
        },
        {
          "value": "permanent_resident",
          "label": "Permanent resident"
        },
        {
          "value": "not_sure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Residency rules set renewal dates and how long you can stay."
    },
    {
      "key": "residencyProgram",
      "stage": "check",
      "question": "Which residency program are you in or applying for?",
      "type": "choice",
      "options": [
        {
          "value": "pensionado",
          "label": "Pensionado (retiree)"
        },
        {
          "value": "friendly_nations",
          "label": "Friendly Nations (Países Amigos)"
        },
        {
          "value": "qualified_investor",
          "label": "Qualified Investor"
        },
        {
          "value": "other",
          "label": "Other"
        },
        {
          "value": "not_sure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Each residency program has its own renewal steps and dates.",
      "showIf": {
        "residencyStatus": [
          "application_pending",
          "provisional_resident",
          "permanent_resident"
        ]
      }
    },
    {
      "key": "keyDate",
      "stage": "check",
      "question": "When did you last enter Panama, or when does your residency card expire?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "research",
      "showIf": {
        "residencyStatus": [
          "tourist",
          "remote_worker_visa",
          "application_pending",
          "provisional_resident",
          "permanent_resident"
        ]
      },
      "dateAs": {
        "by": "residencyStatus",
        "map": {
          "tourist": "entryDate",
          "application_pending": "carneExpiryDate",
          "provisional_resident": "carneExpiryDate",
          "permanent_resident": "idCardExpiryDate"
        }
      },
      "why": "Stay limits and card renewals are dated from it.",
      "help": "Tourists: the date of your last entry stamp. Residents: the expiry date on your card. Skip this if you are not sure."
    },
    {
      "key": "ownsProperty",
      "stage": "check",
      "question": "Do you own real estate in Panama?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "yes_primary_home",
          "label": "Yes, the home I live in",
          "sets": {
            "ownsProperty": "yes",
            "propertyHolding": "yes_primary_home"
          }
        },
        {
          "value": "yes_second_home",
          "label": "Yes, a second or vacation home",
          "sets": {
            "ownsProperty": "yes",
            "propertyHolding": "yes_second_home"
          }
        },
        {
          "value": "yes_through_company",
          "label": "Yes, through a company or foundation",
          "sets": {
            "ownsProperty": "yes",
            "propertyHolding": "yes_through_company"
          }
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Property owners usually pay local property tax and have a few yearly dates."
    },
    {
      "key": "rentsOutProperty",
      "stage": "check",
      "question": "Do you rent out property in Panama?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "long_term_residential",
          "label": "Yes, long-term to a tenant who lives there (over 6 months)"
        },
        {
          "value": "short_term",
          "label": "Yes, short-term (Airbnb or similar)"
        },
        {
          "value": "commercial",
          "label": "Yes, commercial or office space"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Rental income usually has its own tax returns.",
      "showIf": {
        "ownsProperty": [
          "yes_primary_home",
          "yes_second_home",
          "yes_through_company"
        ]
      }
    },
    {
      "key": "hasCompany",
      "stage": "check",
      "question": "Do you own a Panamanian company or foundation?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "sociedad_anonima",
          "label": "Sociedad anónima (S.A.)"
        },
        {
          "value": "private_interest_foundation",
          "label": "Private interest foundation"
        },
        {
          "value": "both",
          "label": "Both",
          "sets": {
            "hasCompany": [
              "sociedad_anonima",
              "private_interest_foundation",
              "both"
            ]
          }
        },
        {
          "value": "other",
          "label": "Another type (S. de R.L., etc.)"
        },
        {
          "value": "not_sure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Companies have yearly filings, even when they do no business."
    },
    {
      "key": "incorporationHalf",
      "stage": "check",
      "question": "When in the year was it registered at the Registro Público?",
      "type": "choice",
      "options": [
        {
          "value": "jan_jun",
          "label": "January to June"
        },
        {
          "value": "jul_dec",
          "label": "July to December"
        },
        {
          "value": "not_sure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "showIf": {
        "hasCompany": [
          "sociedad_anonima",
          "private_interest_foundation",
          "both"
        ]
      }
    },
    {
      "key": "businessOperatesInPanama",
      "stage": "check",
      "question": "Do you or your company run a business in Panama (customers, sales or services there)?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes"
        },
        {
          "value": "no",
          "label": "No, it only holds assets or works abroad"
        },
        {
          "value": "not_sure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "ownsVehicle",
      "stage": "check",
      "question": "Do you own a vehicle with Panamanian plates?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "yes",
          "label": "Yes"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Vehicles have yearly fees, inspections and insurance dates."
    },
    {
      "key": "vehicleRenewalMonth",
      "stage": "check",
      "question": "Which month is on your current plate sticker?",
      "type": "month",
      "options": [
        {
          "value": "1",
          "label": "January"
        },
        {
          "value": "2",
          "label": "February"
        },
        {
          "value": "3",
          "label": "March"
        },
        {
          "value": "4",
          "label": "April"
        },
        {
          "value": "5",
          "label": "May"
        },
        {
          "value": "6",
          "label": "June"
        },
        {
          "value": "7",
          "label": "July"
        },
        {
          "value": "8",
          "label": "August"
        },
        {
          "value": "9",
          "label": "September"
        },
        {
          "value": "10",
          "label": "October"
        },
        {
          "value": "11",
          "label": "November"
        },
        {
          "value": "12",
          "label": "December"
        }
      ],
      "showIf": {
        "ownsVehicle": [
          "yes"
        ]
      },
      "optional": true,
      "source": "research",
      "why": "The yearly plate renewal and inspection follow that month."
    },
    {
      "key": "hasEmployees",
      "stage": "check",
      "question": "Do you employ anyone in Panama?",
      "type": "choice",
      "options": [
        {
          "value": "no",
          "label": "No"
        },
        {
          "value": "domestic_staff",
          "label": "Household staff (housekeeper, gardener, driver, carer)"
        },
        {
          "value": "business_staff",
          "label": "Staff in a business"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Employers, including households with staff, have monthly payments and yearly bonuses."
    },
    {
      "key": "hasPanamaIncome",
      "stage": "check",
      "question": "Do you earn income from Panama (rent, a local business, local fees)? Foreign pensions and foreign salaries don't count.",
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
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "hasPanamaWill",
      "stage": "check",
      "question": "Do you have a Panamanian will covering your Panama assets?",
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
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "showIf": {
        "ownsProperty": [
          "yes_primary_home",
          "yes_second_home",
          "yes_through_company"
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
      "key": "drivesInPanama",
      "stage": "profile",
      "question": "Do you drive in Panama?",
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
      "key": "propertyBuiltOrBoughtNew",
      "stage": "profile",
      "question": "Did you build the property or buy it new from a developer?",
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
        "ownsProperty": [
          "yes_primary_home",
          "yes_second_home",
          "yes_through_company"
        ]
      }
    },
    {
      "key": "planningToSell",
      "stage": "profile",
      "question": "Are you planning to sell property in Panama?",
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
        "ownsProperty": [
          "yes_primary_home",
          "yes_second_home",
          "yes_through_company"
        ]
      }
    },
    {
      "key": "hasPanamaDriverLicense",
      "stage": "profile",
      "question": "Do you have a Panamanian driver's licence?",
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
    }
  ],
  "rules": [
    {
      "id": "PA_IMM_TOURIST_STAY",
      "country": "PA",
      "area": "immigration",
      "title": "Tourist stay limit for US and Canadian citizens may require review",
      "meaning": "US and Canadian visitors may usually stay up to 180 days per entry as tourists; staying longer generally needs a residency or visa process.",
      "when": {
        "all": {
          "residencyStatus": [
            "tourist"
          ],
          "citizenship": [
            "US",
            "CA"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "entryDate",
        "days": 180
      },
      "dueText": "180 days after the date you last entered the country.",
      "authority": "Servicio Nacional de Migración (SNM)",
      "consequence": "Overstaying can lead to fines and problems on exit or re-entry.",
      "sources": [
        "https://www.embassyofpanama.org/visas-1",
        "https://kraemerlaw.com/en/articles/drive-panama-foreign-driver-license-vlog/"
      ],
      "confidence": "medium",
      "notes": "The Panama Embassy (Washington) page cites Resolution 22706 (Sep 2021): US and Canadian citizens may stay up to 180 days. The same page also lists a 3-month limit elsewhere, so it is internally inconsistent. Entry also needs a passport valid for 3+ months, proof of US$500 solvency and an onward ticket. I did not open an SNM page on this.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_FOREIGN_LICENSE_90D",
      "country": "PA",
      "area": "immigration",
      "title": "Driving on a foreign licence after 90 days may require review",
      "meaning": "Tourists can generally drive on their home licence only for the first 90 days after each entry.",
      "when": {
        "all": {
          "residencyStatus": [
            "tourist"
          ],
          "drivesInPanama": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "entryDate",
        "days": 90
      },
      "dueText": "90 days after the date you last entered the country.",
      "authority": "Autoridad del Tránsito y Transporte Terrestre (ATTT)",
      "consequence": "Driving without a valid licence can bring traffic fines and insurance problems after an accident.",
      "sources": [
        "https://kraemerlaw.com/en/articles/drive-panama-foreign-driver-license-vlog/",
        "https://kraemerlaw.com/en/articles/important-panama-ids-residency-card-e-cedula-drivers-license/"
      ],
      "confidence": "medium",
      "notes": "Law firm source; I did not open the ATTT regulation. Kraemer says the 90 days reset after leaving and re-entering.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_REMOTE_WORKER_EXPIRY",
      "country": "PA",
      "area": "immigration",
      "title": "Remote-worker (short-stay) visa expiry may require review",
      "meaning": "The short-stay remote worker visa lasts 9 months and can be extended once for the same period if you still meet the requirements.",
      "when": {
        "all": {
          "residencyStatus": [
            "remote_worker_visa"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visaStartDate",
        "months": 9
      },
      "dueText": "9 months after the visa starts; one extension is possible.",
      "authority": "Servicio Nacional de Migración (SNM)",
      "consequence": "After expiry without an extension or a new status, the person no longer has a legal basis to stay.",
      "sources": [
        "https://www.migracion.gob.pa/wp-content/uploads/18.REQUISITOS-PARA-SOLICITAR-VISA-DE-CORTA-ESTANCIA-COMO-TRABAJADOR-REMOTO.pdf"
      ],
      "confidence": "high",
      "notes": "Official SNM requirements: foreign income at least B/.36,000 a year (B/.3,000 a month), health insurance valid in Panama for the whole stay, and a sworn statement not to take work from Panama-based employers or clients. The extension needs the same documents again.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_PROVISIONAL_CARNE_EXPIRY",
      "country": "PA",
      "area": "immigration",
      "title": "Provisional residency card expiry may require review",
      "meaning": "While a residency application is pending, or during a temporary residency, the card has an expiry date and must be renewed or replaced before it lapses.",
      "when": {
        "all": {
          "residencyStatus": [
            "provisional_resident",
            "application_pending"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "carneExpiryDate",
        "windowStartDays": -60
      },
      "dueText": "On the expiry date on your residency card.",
      "authority": "Servicio Nacional de Migración (SNM)",
      "consequence": "An expired card can leave the person without valid status and may mean fines or restarting steps.",
      "sources": [
        "https://kraemerlaw.com/en/articles/important-panama-ids-residency-card-e-cedula-drivers-license/",
        "https://www.migracion.gob.pa/wp-content/uploads/02-PAISES-ESPECIFICOS.pdf"
      ],
      "confidence": "medium",
      "notes": "Kraemer says the pending-application card is usually valid for about 6 months. Ask the member for the date printed on the card instead of computing it.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_FN_PERMANENT_APPLICATION",
      "country": "PA",
      "area": "immigration",
      "title": "Friendly Nations switch from 2-year provisional to permanent residency may require review",
      "meaning": "Friendly Nations applicants (US and Canada are eligible countries) first get 2-year provisional residency, then must apply for permanent residency with updated documents before it ends.",
      "when": {
        "all": {
          "residencyProgram": [
            "friendly_nations"
          ],
          "residencyStatus": [
            "provisional_resident"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "provisionalApprovalDate",
        "months": 24
      },
      "dueText": "Apply before the 2-year provisional residency ends.",
      "authority": "Servicio Nacional de Migración (SNM)",
      "consequence": "Missing the window can mean the provisional status lapses.",
      "sources": [
        "https://www.migracion.gob.pa/wp-content/uploads/02-PAISES-ESPECIFICOS.pdf",
        "https://www.ndm.com.pa/?p=5372"
      ],
      "confidence": "medium",
      "notes": "The official SNM requirements PDF (undated) lists qualifying routes as real estate of at least B/.200,000, a 3-year fixed deposit of B/.200,000, or a Panama job offer, with a 'Residencia Provisional por periodo de dos (2) años'. One law firm page cites US$300,000 and a change on 15 Oct 2026 but seems to mix this up with the Qualified Investor rules. Thresholds should be confirmed by a lawyer before any member communication.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_QI_ANNUAL_MICI",
      "country": "PA",
      "area": "immigration",
      "title": "Qualified Investor annual MICI filing may require review",
      "meaning": "Under the 2026 decree, Qualified Investor residents file with the Ministry of Commerce (MICI) each year, within 30 days before the anniversary of their residency resolution, to show the investment is still held.",
      "when": {
        "all": {
          "residencyProgram": [
            "qualified_investor"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "residencyResolutionDate",
        "annual": true,
        "windowStartDays": -30
      },
      "dueText": "Within the 30 days before each anniversary of your residency resolution.",
      "authority": "Ministerio de Comercio e Industrias (MICI) and SNM",
      "consequence": "Not keeping the qualifying investment, or not filing, could put the residency at risk.",
      "sources": [
        "https://www.imidaily.com/program-updates/panama-raises-investor-visa-property-minimum-to-us500000-with-a-us300000-carve-out/"
      ],
      "confidence": "medium",
      "notes": "New in Executive Decree No. 17 (published 16 Sep 2026). Only a secondary source was read, not the Gaceta Oficial text. The investment must be held at least 5 years.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_PERMANENT_CARNE_CHECK",
      "country": "PA",
      "area": "immigration",
      "title": "Permanent residency card and cédula E expiry may require review",
      "meaning": "Permanent residency itself does not need renewing (for example Pensionado), but the physical card or the foreigner's cédula may carry an expiry date to replace before it lapses.",
      "when": {
        "all": {
          "residencyStatus": [
            "permanent_resident"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "idCardExpiryDate",
        "windowStartDays": -90
      },
      "dueText": "On the expiry date on your card.",
      "authority": "Servicio Nacional de Migración (carné); Tribunal Electoral (cédula)",
      "consequence": "An expired ID can block bank, notary, vehicle and property paperwork.",
      "sources": [
        "https://www.migracion.gob.pa/wp-content/uploads/02-JUBILADO-PENSIONADO.pdf",
        "https://kraemerlaw.com/en/articles/important-panama-ids-residency-card-e-cedula-drivers-license/",
        "https://www.prensa.com/impresa/panorama/cedulas-y-carnes-de-residencia-tendran-validez-por-15-anos/"
      ],
      "confidence": "low",
      "notes": "Sources conflict. The SNM Pensionado PDF says the permit is indefinite (US$1,000/month lifetime pension, or US$750 with Panama property over US$100,000). Kraemer says the permanent card has no expiry date. La Prensa (May 2020) reports that IDs and permanent-resident cards issued from 1 June 2020 are valid for 15 years. Use the date printed on the member's card.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_IMM_RESIDENT_DRIVER_LICENSE",
      "country": "PA",
      "area": "immigration",
      "title": "Getting a Panamanian driver's licence after residency may require review",
      "meaning": "Once a foreigner holds a residency card they are no longer treated as a tourist and generally need a Panamanian licence, usually by exchanging an authenticated home licence at Sertracen.",
      "when": {
        "all": {
          "residencyStatus": [
            "provisional_resident",
            "permanent_resident"
          ],
          "drivesInPanama": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "residency card issued"
      },
      "dueText": "Residency card issued.",
      "authority": "ATTT, via Sertracen",
      "consequence": "Driving on a foreign licence as a resident can bring fines and insurance problems.",
      "sources": [
        "https://kraemerlaw.com/en/articles/important-panama-ids-residency-card-e-cedula-drivers-license/"
      ],
      "confidence": "medium",
      "notes": "The source gives no fixed grace period. The process involves consulate authentication of the foreign licence, certification by the Foreign Ministry and a blood-type test.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_IDI_INSTALLMENTS",
      "country": "PA",
      "area": "property",
      "title": "Property tax installments may require review",
      "meaning": "Annual real estate tax (impuesto de inmuebles) is paid to the DGI in three parts, based on the cadastral value above the exempt amount.",
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
            4,
            30
          ],
          [
            8,
            31
          ],
          [
            12,
            31
          ]
        ]
      },
      "dueText": "Each year on April 30, August 31, December 31.",
      "authority": "Dirección General de Ingresos (DGI), e-Tax 2.0",
      "consequence": "Late installments carry a surcharge and interest, and unpaid tax blocks the paz y salvo needed to sell or transfer.",
      "sources": [
        "https://dgi.mef.gob.pa/INM/INM.php",
        "https://www.expanship.com/pa/blog/panama-property-tax"
      ],
      "confidence": "high",
      "notes": "DGI rates: general regime exempt to B/.30,000; 0.6% to 250k; 0.8% to 500k; 1% above. Primary home / Patrimonio Familiar: exempt to B/.120,000; 0.5% to 700k; 0.7% above. Expanship gives a different upper bracket (0.7% above 250k) and a 31 Aug vs 30 Aug date, so the DGI page is used. Lenders may withhold the tax monthly on mortgaged non-primary homes (Decrees 362/2018, 47/2019, per Expanship). The 10% late surcharge comes from Expanship only.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_IDI_EARLY_DISCOUNT",
      "country": "PA",
      "area": "property",
      "title": "Property tax early-payment discount may require review",
      "meaning": "Paying the whole year's property tax by 30 April gives a 10% discount if the account has no arrears.",
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
          4,
          30
        ]
      },
      "dueText": "Each year by April 30.",
      "authority": "DGI",
      "consequence": "No penalty; the discount is lost.",
      "sources": [
        "https://dgi.mef.gob.pa/INM/INM.php"
      ],
      "confidence": "high",
      "notes": "Ley 208 of 2021, art. 9. Any arrears must be paid first. A secondary source says the end of February; the DGI page says 30 April.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_PRIMARY_HOME_REGISTRATION",
      "country": "PA",
      "area": "property",
      "title": "Primary home (Vivienda Principal / Patrimonio Familiar) registration may require review",
      "meaning": "The lower primary-home rates and the B/.120,000 exemption apply only after the owner asks the DGI for them through e-Tax 2.0, and only from the request date.",
      "when": {
        "all": {
          "propertyHolding": [
            "yes_primary_home"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "after purchase or moving in"
      },
      "dueText": "After purchase or moving in.",
      "authority": "DGI (e-Tax 2.0: Inmuebles > Solicitud de Exoneración)",
      "consequence": "Until registered, the property is taxed at the general rates from B/.30,000 up.",
      "sources": [
        "https://dgi.mef.gob.pa/Preguntas/Exoneracion.php",
        "https://dgi.mef.gob.pa/INM/INM.php"
      ],
      "confidence": "high",
      "notes": "Legal basis: Ley 66 of 17 Oct 2017 and Decreto Ejecutivo 363 of 2018. Needs RUC and NIT. The DGI must answer within 3 months. Categories include a 'jubilado extranjero' (foreign retiree). The owner must be a natural person living there permanently. Patrimonio Familiar options also exist for SAs, foundations and trusts. The finca's e-Tax email must be registered first.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_ANATI_VALUE_UPDATE",
      "country": "PA",
      "area": "property",
      "title": "Updating property values and permits with ANATI may require review",
      "meaning": "Before asking for a primary-home exemption, and after building or improving, the owner usually has to update the declared values and the construction and occupancy permits with the land authority (ANATI).",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "after improvements or before an exemption request"
      },
      "dueText": "After improvements or before an exemption request.",
      "authority": "Autoridad Nacional de Administración de Tierras (ANATI)",
      "consequence": "An exemption request may be refused, or the tax base may be wrong.",
      "sources": [
        "https://dgi.mef.gob.pa/Preguntas/Exoneracion.php"
      ],
      "confidence": "medium",
      "notes": "The DGI FAQ states the step. I did not open ANATI's own page for deadlines or fees. Titling untitled land (derechos posesorios) is an ANATI process under Ley 80 of 2009, but it is not recurring and was not researched in depth.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_NEW_BUILD_EXEMPTION_END",
      "country": "PA",
      "area": "property",
      "title": "End of new-construction property tax exemption may require review",
      "meaning": "New residential improvements are often exempt from property tax for a set number of years. When that ends, tax on the building starts and bills rise.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyBuiltOrBoughtNew": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "occupancyOrRegistrationDate",
        "years": 20
      },
      "dueText": "20 years after the occupancy or registration date of the property.",
      "authority": "DGI",
      "consequence": "The tax bill increases; budgeting surprise rather than a penalty.",
      "sources": [
        "https://www.expanship.com/pa/blog/panama-property-tax"
      ],
      "confidence": "medium",
      "notes": "Secondary source: residential improvements 20 years, non-residential 10 years. The land stays taxable, and the remaining exemption passes to a buyer. Members should check their own property's exemption end date on the DGI account.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_SALE_TAXES",
      "country": "PA",
      "area": "property",
      "title": "Taxes on selling Panama property may require review",
      "meaning": "Selling property generally means paying a transfer tax and an advance on capital gains tax before the deed can be registered at the Registro Público.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "planningToSell": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "before the deed is presented to the Registro Público"
      },
      "dueText": "Before the deed is presented to the Registro Público.",
      "authority": "DGI and Registro Público de Panamá",
      "consequence": "The deed cannot be registered until these taxes are paid and the paz y salvo is obtained.",
      "sources": [
        "https://www.pwc.com/ia/es/Tax-legal-news/calendario-fiscal-2026/panama.html"
      ],
      "confidence": "medium",
      "notes": "PwC 2026 calendar confirms the timing ('antes de la presentación de la Escritura Pública al diario del Registro Público'). Commonly cited rates (2% transfer tax; 3% advance on a 10% capital gains tax) were not checked against an official source.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_PROP_SHORT_TERM_RENTAL_ITBMS",
      "country": "PA",
      "area": "property",
      "title": "ITBMS on short-term rentals may require review",
      "meaning": "Home leases are exempt from ITBMS only when they are the tenant's home and the lease runs longer than 6 months. Shorter rentals are treated as non-residential and can be taxed.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "rentsOutProperty": [
            "short_term",
            "commercial"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "DGI; Autoridad de Turismo de Panamá (ATP) for tourist lodging",
      "consequence": "Unpaid ITBMS, fines and interest; tourist-rental rules may also restrict the activity itself.",
      "sources": [
        "https://dgi.mef.gob.pa/itbms/SE-Itbms.php",
        "https://www.prensa.com/economia/gobierno-propone-elevar-a-15-el-impuesto-a-los-alquileres-turisticos-como-airbnb/"
      ],
      "confidence": "medium",
      "notes": "Código Fiscal art. 1057-V item 02 (DGI page). Rental income from Panama property is Panama-source and taxable in the income tax return. A September 2026 bill proposes 15% ITBMS for platform rentals; not law as of 2026-10-27. The B/.36,000 annual figure appears on the DGI page as the threshold for a non-contributor certificate. Whether a small landlord must register should be confirmed by a lawyer.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_TASA_UNICA",
      "country": "PA",
      "area": "corporate",
      "title": "Annual franchise tax (tasa única) may require review",
      "meaning": "Every Panamanian sociedad anónima pays B/.300 a year, and every private interest foundation B/.400 a year, to the DGI. The due date depends on when it was registered.",
      "when": {
        "all": {
          "hasCompany": [
            "sociedad_anonima",
            "private_interest_foundation"
          ]
        }
      },
      "due": {
        "kind": "annualByAnswer",
        "answer": "incorporationHalf",
        "map": {
          "jan_jun": [
            7,
            15
          ],
          "jul_dec": [
            1,
            15
          ]
        }
      },
      "dueText": "July 15 each year if registered January to June; January 15 if registered July to December.",
      "authority": "DGI",
      "consequence": "B/.50 late surcharge. After three unpaid years a company is suspended and needs a B/.1,000 reinstatement fine plus a B/.25 registry fee.",
      "sources": [
        "https://dgi.mef.gob.pa/Preguntas/TasaU.php",
        "https://www.pwc.com/ia/es/Tax-legal-news/calendario-fiscal-2026/panama.html"
      ],
      "confidence": "high",
      "notes": "The resident agent usually pays it and bills the client. Foundations have no reinstatement fine but must stay current. Some secondary sites wrongly say it is paid to the Registro Público.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_RESIDENT_AGENT",
      "country": "PA",
      "area": "corporate",
      "title": "Keeping a resident agent appointed may require review",
      "meaning": "Every Panamanian company or foundation must have a Panamanian lawyer or law firm as resident agent. If the agent resigns, for example over missing documents or unpaid fees, a new one must be appointed.",
      "when": {
        "all": {
          "hasCompany": [
            "sociedad_anonima",
            "private_interest_foundation"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Registro Público de Panamá; Superintendencia de Sujetos No Financieros (SSNF)",
      "consequence": "Without an agent the entity cannot register acts and can face suspension of its corporate rights.",
      "sources": [
        "https://cnbc.mef.gob.pa/wp-content/uploads/2022/10/ley-129-de-2020.pdf",
        "https://dgi.mef.gob.pa/Preguntas/AgenteR.php"
      ],
      "confidence": "high",
      "notes": "Ley 129 of 2020 art. 20: a departing agent notifies the SSNF within 10 business days, and a new agent within 15 business days of appointment. The DGI suggests agents resign from entities that do not provide accounting information. Good ILP opportunity: annual agent invoice and resignation risk.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_BENEFICIAL_OWNER_UPDATE",
      "country": "PA",
      "area": "corporate",
      "title": "Telling the resident agent about owner changes may require review",
      "meaning": "The company or foundation must tell its resident agent within 15 business days of any change in who ultimately owns or controls it, so the agent can update the private beneficial-owner register (RUBF).",
      "when": {
        "all": {
          "hasCompany": [
            "sociedad_anonima",
            "private_interest_foundation"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "ownershipChangeDate",
        "businessDays": 15
      },
      "dueText": "15 business days after the date ownership changed.",
      "authority": "Superintendencia de Sujetos No Financieros (SSNF), via the resident agent",
      "consequence": "Agent fines of B/.1,000 to B/.50,000 per entity, daily fines of B/.500, and SSNF-ordered suspension of the entity's corporate rights.",
      "sources": [
        "https://cnbc.mef.gob.pa/wp-content/uploads/2022/10/ley-129-de-2020.pdf",
        "https://ssnf.gob.pa/wp-content/uploads/2022/04/Preguntas-Frecuentes-de-Registro-Unico-de-BF.pdf"
      ],
      "confidence": "high",
      "notes": "Ley 129 of 2020 arts. 7, 11, 12, 23, 24. The agent registers within 15 business days of incorporation or appointment and updates within 5 business days of receiving information. No percentage threshold is in the law, which refers to Ley 23 of 2015.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_ACCOUNTING_RECORDS_TO_AGENT",
      "country": "PA",
      "area": "corporate",
      "title": "Annual accounting records or sworn statement to the resident agent may require review",
      "meaning": "Each year companies and foundations that do not operate in Panama, or only hold assets, must give their resident agent financial statements or a summary, an asset-holding affidavit, or a no-activity statement for the prior year.",
      "when": {
        "all": {
          "hasCompany": [
            "sociedad_anonima",
            "private_interest_foundation"
          ],
          "businessOperatesInPanama": [
            "no"
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
      "authority": "DGI (resident agent files the sworn declaration of accounting records through e-Tax 2.0)",
      "consequence": "Fines from US$5,000 to US$1,000,000, suspension of corporate rights, and the agent may resign.",
      "sources": [
        "https://alcogal.com/?p=13377",
        "https://www.uniwide.com/panama-accounting-record-obligations-deadline-for-companies-2026/",
        "https://dgi.mef.gob.pa/Preguntas/AgenteR.php"
      ],
      "confidence": "medium",
      "notes": "Law 52 of 2016 as amended by Law 254 of 2021, plus Executive Decree 177 of 30 Dec 2024. Two firms give 30 April for delivery to the agent. The agent's own DGI filing date has moved: the DGI FAQ gives 15 Jul 2025 for fiscal 2024, and Forvis Mazars cites 15 June. Records are kept 5 years. Agents often set earlier internal deadlines.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_RECORDS_LOCATION_CHANGE",
      "country": "PA",
      "area": "corporate",
      "title": "Change of where company books are kept may require review",
      "meaning": "If the books are not kept at the resident agent's office, the agent must have the custodian's name and address, and changes must be reported promptly.",
      "when": {
        "all": {
          "hasCompany": [
            "sociedad_anonima",
            "private_interest_foundation"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "changeDate",
        "businessDays": 15
      },
      "dueText": "15 business days after the date of the change.",
      "authority": "DGI, via the resident agent",
      "consequence": "Same sanction regime as the records rule (fines, suspension).",
      "sources": [
        "https://www.uniwide.com/panama-accounting-record-obligations-deadline-for-companies-2026/",
        "https://alcogal.com/?p=13377"
      ],
      "confidence": "medium",
      "notes": "The 15-business-day figure comes from one secondary source and was not checked in the decree text.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_INCOME_TAX_RETURN",
      "country": "PA",
      "area": "corporate",
      "title": "Company income tax return may require review",
      "meaning": "A company registered with the DGI as operating (with an Aviso de Operación or RUC obligations) files an annual income tax return 3 months after its fiscal year ends, even with zero or only foreign income.",
      "when": {
        "all": {
          "hasCompany": [
            "sociedad_anonima",
            "other"
          ],
          "businessOperatesInPanama": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "fiscalYearEnd",
        "months": 3,
        "fallback": [
          3,
          31
        ]
      },
      "dueText": "3 months after the company's year-end (March 31 for a calendar year).",
      "authority": "DGI (e-Tax 2.0)",
      "consequence": "Automatic fines for late filing; tax plus surcharges and interest if tax is due.",
      "sources": [
        "https://www.pwc.com/ia/es/Tax-legal-news/calendario-fiscal-2026/panama.html",
        "https://accounts-os.com/pa/questions/do-i-need-to-file-an-income-tax-return-if-my-company-had-no-income-in-panama"
      ],
      "confidence": "high",
      "notes": "PwC confirms 3 months after year-end. A secondary source says a one-month extension may be requested before the deadline. Estimated tax installments follow at 6, 9 and 12 months after year-end. Whether a purely passive, non-operating SA must file a DGI return (as opposed to the resident-agent records rule) should be confirmed by a lawyer.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_CORP_AVISO_OPERACION",
      "country": "PA",
      "area": "corporate",
      "title": "Business operating licence (Aviso de Operación) and its annual tax may require review",
      "meaning": "Anyone carrying on a business in Panama needs an Aviso de Operación from Panamá Emprende (MICI). It brings an annual tax of 2% of net capital (minimum B/.100, maximum B/.60,000), declared on the income tax return.",
      "when": {
        "all": {
          "businessOperatesInPanama": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "before starting operations; annual tax with the income tax return; cancel within 30 days of closing"
      },
      "dueText": "Before starting operations; annual tax with the income tax return; cancel within 30 days of closing.",
      "authority": "Ministerio de Comercio e Industrias (Panamá Emprende); DGI; municipality",
      "consequence": "Operating without one can bring fines. Not cancelling after closing keeps return obligations alive and adds fines.",
      "sources": [
        "https://www.prensa.com/opinion/notas-tributarias-al-obtener-un-aviso-de-operacion/"
      ],
      "confidence": "medium",
      "notes": "Source is a tax column in La Prensa (16 Aug 2025). Capital under B/.10,000 is exempt from the tax. Holders must file a return even before starting operations. Municipal business tax and CSS registration also follow. Monthly municipal tax amounts were not researched.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_TAX_INDIVIDUAL_RETURN",
      "country": "PA",
      "area": "tax",
      "title": "Personal income tax return may require review",
      "meaning": "Individuals with Panama-source income other than a single salary taxed through payroll file a return by 15 March for the prior year. Foreign income, including foreign pensions, is generally outside Panama's territorial tax.",
      "when": {
        "all": {
          "hasPanamaIncome": [
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
      "dueText": "Each year by March 15.",
      "authority": "DGI (e-Tax 2.0)",
      "consequence": "Late-filing fines plus surcharges and interest on unpaid tax.",
      "sources": [
        "https://taxsummaries.pwc.com/panama/individual/tax-administration",
        "https://taxsummaries.pwc.com/panama/individual/taxes-on-personal-income"
      ],
      "confidence": "high",
      "notes": "Typical triggers: rental income from Panama property, a local business or consulting, Panama-source capital gains. US citizens still file with the IRS, and Canadians may still have CRA duties; flag for a cross-border adviser.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_TAX_ESTIMATED_INSTALLMENTS",
      "country": "PA",
      "area": "tax",
      "title": "Estimated income tax installments may require review",
      "meaning": "If the prior return produced an estimated tax for the current year, it is paid in three equal parts.",
      "when": {
        "all": {
          "hasPanamaIncome": [
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
            9,
            30
          ],
          [
            12,
            31
          ]
        ]
      },
      "dueText": "Each year on June 30, September 30, December 31.",
      "authority": "DGI",
      "consequence": "Surcharges and interest on late installments.",
      "sources": [
        "https://taxsummaries.pwc.com/panama/individual/tax-administration",
        "https://www.pwc.com/ia/es/Tax-legal-news/calendario-fiscal-2026/panama.html"
      ],
      "confidence": "high",
      "notes": "For calendar-year taxpayers. Seguro educativo is paid with the installments according to PwC.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_TAX_ITBMS_MONTHLY",
      "country": "PA",
      "area": "tax",
      "title": "Monthly ITBMS (sales tax) return may require review",
      "meaning": "People or companies registered for ITBMS (7% standard; 10% for lodging) file and pay monthly within the first 15 days of the following month.",
      "when": {
        "all": {
          "rentsOutProperty": [
            "short_term",
            "commercial"
          ],
          "businessOperatesInPanama": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": 15
      },
      "dueText": "By the 15th of each month.",
      "authority": "DGI",
      "consequence": "B/.10 fine per late return plus surcharges and interest on unpaid tax.",
      "sources": [
        "https://dgi.mef.gob.pa/itbms/Generalidades.php",
        "https://dgi.mef.gob.pa/itbms/SE-Itbms.php"
      ],
      "confidence": "high",
      "notes": "appliesWhen is an OR of the two conditions. Registration thresholds for small landlords were not confirmed (see PA_PROP_SHORT_TERM_RENTAL_ITBMS).",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_VEH_ANNUAL_PLATE_RENEWAL",
      "country": "PA",
      "area": "vehicle",
      "title": "Annual vehicle registration (plate/sticker, circulation tax) may require review",
      "meaning": "Each year, in the vehicle's assigned month, the owner pays the municipal circulation tax and gets the new plate or sticker. This requires a municipal paz y salvo and a current revisado.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthByAnswer",
        "answer": "vehicleRenewalMonth"
      },
      "dueText": "Each year in the month on your plate sticker.",
      "authority": "Municipality where the vehicle is registered (e.g. Alcaldía de Panamá, Tesorería); ATTT",
      "consequence": "Municipio de Panamá 'desacato' late sanctions (B/.52.60 sedans, B/.54.20 4x4, per Nov 2025 press) plus ATTT fines for expired plates.",
      "sources": [
        "https://www.laestrella.com.pa/panama/informacion-util/atencion-conductores-alcaldia-de-panama-inicia-entrega-de-placas-y-calcomanias-de-noviembre-2025-EA17355760"
      ],
      "confidence": "medium",
      "notes": "The rule assigning a month to a vehicle was not found. Ask the member for the month on the current sticker or registration. Amounts are for Municipio de Panamá only; other municipalities differ.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_VEH_REVISADO",
      "country": "PA",
      "area": "vehicle",
      "title": "Annual vehicle inspection (revisado vehicular) may require review",
      "meaning": "A current annual inspection is a precondition for the plate renewal, so it needs doing shortly before the renewal month.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthByAnswer",
        "answer": "vehicleRenewalMonth",
        "offsetDays": -30
      },
      "dueText": "Before the plate renewal month each year.",
      "authority": "ATTT (authorised inspection centres)",
      "consequence": "Without it the plate or sticker cannot be issued.",
      "sources": [
        "https://www.laestrella.com.pa/panama/informacion-util/atencion-conductores-alcaldia-de-panama-inicia-entrega-de-placas-y-calcomanias-de-noviembre-2025-EA17355760"
      ],
      "confidence": "medium",
      "notes": "The 30-day lead time is a product choice, not a legal rule.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_VEH_INSURANCE",
      "country": "PA",
      "area": "vehicle",
      "title": "Mandatory basic vehicle insurance renewal may require review",
      "meaning": "Panama requires a basic compulsory traffic accident insurance (third-party injury and property damage) to be kept in force on every vehicle.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "insuranceExpiryDate",
        "windowStartDays": -30
      },
      "dueText": "On the date your policy expires.",
      "authority": "ATTT; Superintendencia de Seguros y Reaseguros",
      "consequence": "Traffic fines, and personal liability for damage after an accident.",
      "sources": [
        "https://www.tvn-2.com/nacionales/nueva-ley-seguro-obligatorio-accidentes-transito-samir-gozaine-aseguradoras-autos-panama_1_1369158.html"
      ],
      "confidence": "medium",
      "notes": "Ley 68 of 13 Dec 2016 (in force March 2017). Minimum amounts were not confirmed.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_VEH_LICENSE_RENEWAL",
      "country": "PA",
      "area": "vehicle",
      "title": "Panamanian driver's licence renewal may require review",
      "meaning": "A Panamanian licence has an expiry date and is renewed at Sertracen.",
      "when": {
        "all": {
          "hasPanamaDriverLicense": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "licenseExpiryDate",
        "windowStartDays": -30
      },
      "dueText": "On the expiry date on your licence.",
      "authority": "ATTT, via Sertracen",
      "consequence": "Driving on an expired licence brings fines and insurance problems.",
      "sources": [
        "https://kraemerlaw.com/en/articles/important-panama-ids-residency-card-e-cedula-drivers-license/"
      ],
      "confidence": "low",
      "notes": "Validity period not researched; use the date printed on the licence. A foreign resident's licence may be tied to residency card validity (not confirmed).",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_LAB_CSS_REGISTRATION",
      "country": "PA",
      "area": "employment",
      "title": "Registering employees (including domestic staff) with the CSS may require review",
      "meaning": "Anyone who employs someone in Panama, including a household employee, must register as an employer and enrol the worker with the Caja de Seguro Social.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_staff",
            "business_staff"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "at hire"
      },
      "dueText": "At hire.",
      "authority": "Caja de Seguro Social (CSS); Ministerio de Trabajo (MITRADEL)",
      "consequence": "Back contributions with surcharges, and liability for the worker's medical or pension coverage gaps; labour claims at MITRADEL.",
      "sources": [
        "https://finiquitojusto.com/?p=4234",
        "https://www.tvn-2.com/nacionales/reformas-a-la-css-aumento-escalonado-cuota-patronal-caja-de-seguro-social_1_2182102.html"
      ],
      "confidence": "medium",
      "notes": "The domestic-worker source is a worker-rights guide, not CSS. It quotes an 8.25% employer rate that may predate Ley 462 of 2025, so do not use that rate. Confirm the domestic-employer regime with the CSS.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_LAB_CSS_MONTHLY",
      "country": "PA",
      "area": "employment",
      "title": "Monthly CSS contributions may require review",
      "meaning": "Employers file payroll and pay employer and employee social security contributions every month through the CSS SIPE system.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_staff",
            "business_staff"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Each month; the exact payment day was not confirmed.",
      "authority": "Caja de Seguro Social (CSS), SIPE",
      "consequence": "Late-payment surcharges; the CSS can pursue the employer.",
      "sources": [
        "https://www.tvn-2.com/nacionales/reformas-a-la-css-aumento-escalonado-cuota-patronal-caja-de-seguro-social_1_2182102.html",
        "https://www.laestrella.com.pa/panama/nacional/caja-de-seguro-social-extiende-el-plazo-de-pago-de-cuotas-y-tramites-de-octubre-CL17947702"
      ],
      "confidence": "low",
      "notes": "Rates (Ley 462/2025): employer 13.25% until 28 Feb 2027, then 14.25%, then 15.25% from 1 Mar 2029; employee 9.75%. The CSS sometimes extends monthly deadlines (October 2025 contributions moved to 2 Dec 2025), which suggests the normal due date falls in the following month. The exact day needs confirming on css.gob.pa.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_LAB_DECIMO",
      "country": "PA",
      "area": "employment",
      "title": "Thirteenth-month pay (décimo tercer mes) may require review",
      "meaning": "Employers pay a thirteenth month in three installments, each covering the prior four months of work.",
      "when": {
        "all": {
          "hasEmployees": [
            "domestic_staff",
            "business_staff"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            4,
            15
          ],
          [
            8,
            15
          ],
          [
            12,
            15
          ]
        ]
      },
      "dueText": "Each year on April 15, August 15, December 15.",
      "authority": "MITRADEL",
      "consequence": "Late payment puts the employer in default with interest, and the worker can complain to MITRADEL.",
      "sources": [
        "https://www.laestrella.com.pa/economia/como-calcular-el-decimo-tercer-mes-en-panama-guia-y-ejemplos-BP21487372",
        "https://finiquitojusto.com/derechos-laborales/decimo-tercer-mes-panama/"
      ],
      "confidence": "high",
      "notes": "Origin: Decreto de Gabinete 221 of 18 Nov 1971. Periods: Dec-Mar, Apr-Jul, Aug-Nov. Domestic workers are generally understood to be covered, but no official page confirming this was opened.",
      "reviewedByCounsel": false
    },
    {
      "id": "PA_EST_WILL_REVIEW",
      "country": "PA",
      "area": "estate",
      "title": "Panama will covering Panama assets may require review",
      "meaning": "A Panamanian will, usually an open will before a notary, can make probate of Panama property, bank accounts and company shares faster than relying on a foreign will or no will.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "hasPanamaWill": [
            "no"
          ]
        }
      },
      "due": {
        "kind": "event",
        "trigger": "after buying property, forming a company or foundation, marriage, divorce, birth or death in the family"
      },
      "dueText": "After buying property, forming a company or foundation, marriage, divorce, birth or death in the family.",
      "authority": "Notaría (will); Juzgado de Circuito Civil (probate / juicio de sucesión)",
      "consequence": "Without a will, Panama's intestacy order applies (spouse and children equally, then parents or siblings) and probate is slower.",
      "sources": [
        "https://kraemerlaw.com/en/articles/should-i-record-a-will-in-panama/",
        "https://www.globalpropertyguide.com/latin-america/panama/inheritance"
      ],
      "confidence": "medium",
      "notes": "Wills can be holograph, closed or open (Civil Code, Ley 2 of 1916). There is no forced heirship and no inheritance tax since 2002. Probate with a will and agreeing heirs takes about 4-8 months, with heirs published in a newspaper for 3 days. Private interest foundations are a common alternative. Recognition of foreign wills was not researched.",
      "reviewedByCounsel": false
    }
  ]
};
