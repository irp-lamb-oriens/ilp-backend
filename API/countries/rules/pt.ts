/**
 * API/countries/rules/pt.ts: Portugal (PT). GENERATED, do not edit by hand.
 * Source: docs/research/portugal.md (research date 2026-10-27), imported by
 * scripts/importCountryResearch.py. 39 rules (2 low confidence), 20 questions.
 * Every rule has reviewedByCounsel: false until a Portugal partner lawyer signs it off.
 */
import type { CountryRuleset } from "./engine.ts";

export const PT_RULESET: CountryRuleset = {
  "country": "PT",
  "researchDate": "2026-10-27",
  "questions": [
    {
      "key": "residencyStatus",
      "stage": "check",
      "question": "What is your current status in Portugal?",
      "type": "choice",
      "options": [
        {
          "value": "visitor",
          "label": "Visitor (no Portuguese visa or permit)"
        },
        {
          "value": "residence_visa_holder",
          "label": "I have a D7, D8 or other residence visa but no card yet"
        },
        {
          "value": "temporary_resident",
          "label": "Temporary residence permit (D7, D8, work, other)"
        },
        {
          "value": "golden_visa",
          "label": "Golden visa (ARI)"
        },
        {
          "value": "permanent_resident",
          "label": "Permanent residence"
        },
        {
          "value": "citizen_or_eu",
          "label": "Portuguese or EU citizen"
        }
      ],
      "optional": false,
      "source": "research",
      "why": "Residency rules set renewal dates and how long you can stay."
    },
    {
      "key": "permitExpiryDate",
      "stage": "check",
      "question": "When does your residence card expire?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "research",
      "showIf": {
        "residencyStatus": [
          "temporary_resident",
          "golden_visa",
          "permanent_resident"
        ]
      },
      "why": "Renewals are dated from it.",
      "help": "It is printed on the card. Skip this if you do not have it at hand."
    },
    {
      "key": "isTaxResident",
      "stage": "check",
      "question": "Did you spend more than 183 days in Portugal in the last 12 months, or is your main home there?",
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
      "why": "Tax residents file a yearly return and some declarations that visitors do not."
    },
    {
      "key": "taxRegime",
      "stage": "check",
      "question": "Do you have a special tax regime?",
      "type": "choice",
      "options": [
        {
          "value": "nhr",
          "label": "NHR (non-habitual resident)",
          "sets": {
            "hasNHR": "yes"
          }
        },
        {
          "value": "ifici",
          "label": "IFICI (2024+ regime)",
          "sets": {
            "hasNHR": "no"
          }
        },
        {
          "value": "arrived_recently",
          "label": "No, but I became resident this year or last year",
          "sets": {
            "becameResidentLastYear": "yes"
          }
        },
        {
          "value": "none",
          "label": "No",
          "sets": {
            "hasNHR": "no"
          }
        },
        {
          "value": "unsure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "showIf": {
        "isTaxResident": [
          "yes"
        ]
      }
    },
    {
      "key": "ownsProperty",
      "stage": "check",
      "question": "Do you own property in Portugal?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "Yes, in my name"
        },
        {
          "value": "company",
          "label": "Yes, through a company",
          "sets": {
            "ownsProperty": [
              "yes",
              "company"
            ]
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
      "key": "propertyValueBand",
      "stage": "check",
      "question": "Roughly what is the total tax value (VPT) of your Portuguese property?",
      "type": "choice",
      "options": [
        {
          "value": "under_600k",
          "label": "Under EUR 600,000"
        },
        {
          "value": "over_600k",
          "label": "EUR 600,000 or more"
        },
        {
          "value": "unsure",
          "label": "Not sure"
        }
      ],
      "optional": false,
      "source": "research",
      "showIf": {
        "ownsProperty": [
          "yes",
          "company"
        ]
      }
    },
    {
      "key": "rentsOutProperty",
      "stage": "check",
      "question": "Do you rent out property in Portugal?",
      "type": "choice",
      "options": [
        {
          "value": "long_term",
          "label": "Yes, long-term lease",
          "sets": {
            "rentsOutProperty": [
              "yes",
              "long_term"
            ]
          }
        },
        {
          "value": "short_term",
          "label": "Yes, short-term / holiday rental (Alojamento Local)",
          "sets": {
            "rentsOutProperty": [
              "yes",
              "short_term"
            ]
          }
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
          "yes",
          "company"
        ]
      }
    },
    {
      "key": "hasCompany",
      "stage": "check",
      "question": "Do you own or manage a Portuguese company (Lda., Unipessoal, SA)?",
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
      "key": "ownsVehicle",
      "stage": "check",
      "question": "Do you own or drive a car in Portugal?",
      "type": "choice",
      "options": [
        {
          "value": "yes",
          "label": "I own a Portuguese-registered car",
          "sets": {
            "ownsVehicle": "yes",
            "drivesInPortugal": "yes"
          }
        },
        {
          "value": "drive_only",
          "label": "I drive but do not own one",
          "sets": {
            "ownsVehicle": "no",
            "drivesInPortugal": "yes"
          }
        },
        {
          "value": "no",
          "label": "No",
          "sets": {
            "ownsVehicle": "no",
            "drivesInPortugal": "no"
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
      "question": "Do you employ a cleaner, carer, nanny or gardener directly?",
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
      "key": "hasPortugueseWill",
      "stage": "check",
      "question": "Do you have a will that covers your Portuguese assets?",
      "type": "choice",
      "options": [
        {
          "value": "yes_pt",
          "label": "Yes, a Portuguese will"
        },
        {
          "value": "yes_home",
          "label": "Only a US or Canadian will",
          "sets": {
            "hasPortugueseWill": [
              "no",
              "yes_home"
            ]
          }
        },
        {
          "value": "no",
          "label": "No"
        }
      ],
      "optional": false,
      "source": "research"
    },
    {
      "key": "permitExpired",
      "stage": "profile",
      "question": "Has your residence card already expired?",
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
          "temporary_resident",
          "golden_visa"
        ]
      }
    },
    {
      "key": "hasNIF",
      "stage": "profile",
      "question": "Do you have a Portuguese tax number (NIF)?",
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
      "key": "propertyType",
      "stage": "profile",
      "question": "What kind of property is it?",
      "type": "choice",
      "options": [
        {
          "value": "apartment",
          "label": "An apartment"
        },
        {
          "value": "house",
          "label": "A house"
        },
        {
          "value": "land",
          "label": "Land"
        },
        {
          "value": "other",
          "label": "Something else"
        }
      ],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "ownsProperty": [
          "yes",
          "company"
        ]
      }
    },
    {
      "key": "livesInPortugalPartYear",
      "stage": "profile",
      "question": "Do you live in Portugal for part of the year?",
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
      "key": "hasForeignIncomeOrAccounts",
      "stage": "profile",
      "question": "Do you have income or bank accounts outside Portugal?",
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
        "isTaxResident": [
          "yes"
        ]
      }
    },
    {
      "key": "worksInQualifyingRole",
      "stage": "profile",
      "question": "Do you work in research, innovation or another role that qualifies for IFICI?",
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
        "isTaxResident": [
          "yes"
        ]
      }
    },
    {
      "key": "lifeEvent",
      "stage": "profile",
      "question": "Has a close family member died recently?",
      "type": "choice",
      "options": [
        {
          "value": "death_in_family",
          "label": "Yes"
        },
        {
          "value": "none",
          "label": "No"
        }
      ],
      "optional": true,
      "source": "ilp"
    },
    {
      "key": "estateHasPortugueseAssets",
      "stage": "profile",
      "question": "Did they own property or other assets in Portugal?",
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
        "lifeEvent": [
          "death_in_family"
        ]
      }
    },
    {
      "key": "visaIssueDate",
      "stage": "check",
      "question": "When was your residence visa issued?",
      "type": "date",
      "options": [],
      "optional": true,
      "source": "ilp",
      "showIf": {
        "residencyStatus": [
          "residence_visa_holder"
        ]
      },
      "why": "The visa is valid for 120 days, and the AIMA appointment must happen within it.",
      "help": "It is on the visa in your passport. Skip this if you are not sure."
    }
  ],
  "rules": [
    {
      "id": "PT_IMM_PERMIT_RENEWAL",
      "country": "PT",
      "area": "immigration",
      "title": "Residence permit renewal may require review",
      "meaning": "Temporary permits (D7, D8 and similar) last 2 years, then 3; renewal is filed online with AIMA from 90 to 30 days before expiry.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitExpiryDate",
        "days": -30,
        "windowStartDays": -90
      },
      "dueText": "Online with AIMA from 90 to 30 days before the card expires.",
      "authority": "AIMA",
      "consequence": "Right of residence lasts up to 6 months after expiry; after that a new application is needed.",
      "sources": [
        "https://www.gov.pt/en/servicos/renovar-a-autorizacao-de-residencia",
        "https://eiglaw.com/portugal-ends-automatic-extensions-for-residence-permits/",
        "https://www.cidadaniaevisto.com.br/blog/titulo-de-residencia-portugal-tipos-validade-renovacao"
      ],
      "confidence": "high",
      "notes": "2-then-3-year validity from secondary sources (medium).",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_EXPIRED_PERMIT",
      "country": "PT",
      "area": "immigration",
      "title": "Expired residence card may require review",
      "meaning": "An expired card with a pending renewal should be carried with proof of the request; without a request, status lapses 6 months after expiry.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident",
            "golden_visa"
          ],
          "permitExpired": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitExpiryDate",
        "months": 6
      },
      "dueText": "6 months after the expiry date on your residence card.",
      "authority": "AIMA",
      "consequence": "Irregular stay and need for a new application.",
      "sources": [
        "https://eiglaw.com/portugal-ends-automatic-extensions-for-residence-permits/",
        "https://www.lvpadvogados.com/residence-permits-validity-officially-extended-until-15-october-2025"
      ],
      "confidence": "medium",
      "notes": "Blanket extension (DL 85-B/2025) ended 15 Oct 2025; cards expired before 30 Jun 2025 lost status 15 Apr 2026 if no renewal filed.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_ABSENCE_LIMIT",
      "country": "PT",
      "area": "immigration",
      "title": "Time outside Portugal may require review",
      "meaning": "A temporary permit can be cancelled after more than 6 consecutive or 8 non-consecutive months abroad during its validity; permanent after 24 consecutive or 30 interpolated months.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident",
            "permanent_resident"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "AIMA",
      "consequence": "Possible permit cancellation after a hearing.",
      "sources": [
        "https://dnbrasil.dn.pt/pergunte-ao-advogado-é-possível-perder-a-residência-por-ficar-muito-tempo-fora-de-portugal",
        "https://mcs.pt/how-to-apply-for-a-d7-visa-to-live-in-madeira/"
      ],
      "confidence": "medium",
      "notes": "Lei 23/2007 art. 85. Work or medical absences can be justified to AIMA.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_VISA_TO_PERMIT",
      "country": "PT",
      "area": "immigration",
      "title": "AIMA appointment within visa validity may require review",
      "meaning": "A D7 or D8 residence visa is valid 120 days with two entries, during which the AIMA appointment issues the permit.",
      "when": {
        "all": {
          "residencyStatus": [
            "residence_visa_holder"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "visaIssueDate",
        "days": 120
      },
      "dueText": "120 days after the date your visa was issued.",
      "authority": "AIMA; consulate",
      "consequence": "May have to reapply from abroad.",
      "sources": [
        "https://mcs.pt/how-to-apply-for-a-d7-visa-to-live-in-madeira/",
        "https://wheretoemigrate.io/blog/portugal-d7-vs-d8-2026"
      ],
      "confidence": "medium",
      "notes": "2026 income thresholds per secondary source: D7 EUR 920/month, D8 EUR 3,680/month.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_GOLDEN_VISA",
      "country": "PT",
      "area": "immigration",
      "title": "Golden visa stay days and renewal may require review",
      "meaning": "Holders must average 7 days in year one and 14 days per later 2-year period in Portugal, keep the investment 5 years and renew every 2 years.",
      "when": {
        "all": {
          "residencyStatus": [
            "golden_visa"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitExpiryDate",
        "days": -30,
        "windowStartDays": -90
      },
      "dueText": "Renewal every 2 years, filed before the card expires; stay days and the investment are checked.",
      "authority": "AIMA",
      "consequence": "Renewal refused if conditions cannot be evidenced.",
      "sources": [
        "https://connaughtlaw.com/portugal-golden-visa-program-guide/"
      ],
      "confidence": "medium",
      "notes": "Real-estate routes closed Oct 2023. Open routes: EUR 500k fund, 500k research, 250k culture, 500k company + 5 jobs, 10 jobs.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_PERMANENT_RESIDENCE",
      "country": "PT",
      "area": "immigration",
      "title": "Permanent residence eligibility may require review",
      "meaning": "After 5 years of temporary permits a member can apply at AIMA for permanent residence; the card is renewed every 5 years.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "firstPermitIssueDate",
        "years": 5
      },
      "dueText": "5 years after the date your first residence permit was issued.",
      "authority": "AIMA",
      "consequence": "Stays on 3-year renewals and stricter absence limits.",
      "sources": [
        "https://www.gov.pt/servicos/pedir-a-autorizacao-de-residencia-permanente",
        "https://www.cidadaniaevisto.com.br/blog/titulo-de-residencia-portugal-tipos-validade-renovacao"
      ],
      "confidence": "high",
      "notes": "Card renewal period and language requirement medium confidence.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_NATURALISATION",
      "country": "PT",
      "area": "immigration",
      "title": "Citizenship eligibility may require review",
      "meaning": "US and Canadian nationals usually need 10 years of legal residence counted from the first permit's issue date; pre-19 May 2026 applications follow the old 5-year rule.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident",
            "permanent_resident",
            "golden_visa"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "firstPermitIssueDate",
        "years": 10
      },
      "dueText": "10 years after the date your first residence permit was issued.",
      "authority": "IRN (Conservatória dos Registos Centrais)",
      "consequence": "Early applications refused.",
      "sources": [
        "https://en.wikipedia.org/wiki/Portuguese_nationality_law",
        "https://www.cidadaniaevisto.com.br/blog/nova-lei-nacionalidade-portuguesa-2026",
        "https://www.essential-business.pt/2025/12/17/constitutional-court-says-parts-of-portugals-new-nationality-law-unconstitutional/"
      ],
      "confidence": "medium",
      "notes": "Lei Organica 1/2026 in force 19 May 2026; civic test regulation pending as of Sep 2026.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_IMM_SCHENGEN_90_180",
      "country": "PT",
      "area": "immigration",
      "title": "Visitor 90/180-day limit may require review",
      "meaning": "Without a Portuguese permit or visa, US and Canadian visitors may stay 90 days in any 180 across Schengen.",
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
      "dueText": "Rolling 180-day window.",
      "authority": "Border police; EU EES",
      "consequence": "Overstay fines, entry bans.",
      "sources": [
        "https://en.wikipedia.org/wiki/European_Travel_Information_and_Authorisation_System"
      ],
      "confidence": "high",
      "notes": "EES biometric records since late 2025; ETIAS expected 2027.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_ID_FISCAL_REPRESENTATIVE",
      "country": "PT",
      "area": "identity",
      "title": "Fiscal representative or e-notifications may require review",
      "meaning": "A NIF holder living outside the EU/EEA must appoint a fiscal representative or opt in to Portal das Financas electronic notifications.",
      "when": {
        "all": {
          "hasNIF": [
            "yes"
          ],
          "isTaxResident": [
            "no"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Autoridade Tributaria",
      "consequence": "Missed notices still count as served.",
      "sources": [
        "https://www.garrigues.com/pt/pt-PT/news/dispensa-da-nomeacao-representante-fiscal-e-da-obrigatoriedade-adesao-caixa-postal-eletronica",
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/lgt/Pages/lgt19.aspx"
      ],
      "confidence": "high",
      "notes": "DL 44/2022, from 9 Jul 2022.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_ID_NUMERO_UTENTE",
      "country": "PT",
      "area": "identity",
      "title": "Register for an SNS health number may require review",
      "meaning": "A resident gets a numero de utente at the first visit to a public health centre or Espaco Cidadao.",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident",
            "permanent_resident",
            "golden_visa"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Once after arrival.",
      "authority": "SNS",
      "consequence": "No family doctor or booking access.",
      "sources": [
        "https://www.gov.pt/en/servicos/pedir-o-numero-de-utente-do-sns",
        "https://www.portugalist.com/numero-utente/"
      ],
      "confidence": "medium",
      "notes": "Not a deadline; onboarding task.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_PROP_IMI",
      "country": "PT",
      "area": "property",
      "title": "IMI property tax may require review",
      "meaning": "Owners on 31 Dec pay IMI next year: under EUR 100 by 31 May; 100-500 in May and November; over 500 in May, August and November.",
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
            5,
            31
          ],
          [
            8,
            31
          ],
          [
            11,
            30
          ]
        ]
      },
      "dueText": "Under EUR 100: May 31. EUR 100 to 500: May 31 and November 30. Over EUR 500: May 31, August 31 and November 30. Moves to the next business day on a weekend.",
      "authority": "Autoridade Tributaria (municipal rate)",
      "consequence": "Interest; remaining instalments become due; enforcement.",
      "sources": [
        "https://moneylab.pt/2026/05/19/prazos-imi-2026-as-datas-que-nao-pode-falhar",
        "https://invoicexpress.com/blog/calendario-fiscal-junho/",
        "https://observador.pt/2025/05/13/fisco-diz-que-prazo-para-pagar-imi-e-fim-de-junho-mesmo-que-nota-de-liquidacao-indique-maio/"
      ],
      "confidence": "high",
      "notes": "2025 notes payable through June as one-off; 2026 first instalment 1 June (weekend).",
      "reviewedByCounsel": false,
      "rollWeekend": "next"
    },
    {
      "id": "PT_PROP_AIMI",
      "country": "PT",
      "area": "property",
      "title": "AIMI high-value property tax may require review",
      "meaning": "Individuals with taxable property value over EUR 600k (1.2M joint) pay AIMI by 30 September at 0.7%, 1% or 1.5% by band.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyValueBand": [
            "over_600k"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          9,
          30
        ]
      },
      "dueText": "Payment by September 30; the joint-taxation election around May 31.",
      "authority": "Autoridade Tributaria",
      "consequence": "Interest and enforcement.",
      "sources": [
        "https://www.deco.proteste.pt/dinheiro/impostos/dicas/aimi-quem-paga-taxa-adicional-imi",
        "https://www.santander.pt/salto/aimi",
        "https://invoicexpress.com/blog/calendario-fiscal-junho/"
      ],
      "confidence": "medium",
      "notes": "Company rates and election deadline need confirmation.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_PROP_LEASE_COMMUNICATION",
      "country": "PT",
      "area": "property",
      "title": "Lease registration with the tax authority may require review",
      "meaning": "Landlords report a new lease, changes and termination on Modelo 2 by the end of the month after it starts.",
      "when": {
        "all": {
          "rentsOutProperty": [
            "long_term"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "leaseStartDate",
        "endOfMonthAfter": 1
      },
      "dueText": "By the end of the month after the lease starts (same for changes and the end).",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines; late stamp duty with interest.",
      "sources": [
        "https://apcmc.pt/legislacao/recibo-de-renda-eletronico-e-comunicacao-do-arrendamento-a-at/",
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/legislacao/diplomas_legislativos/Documents/Portaria_98_A-2015.pdf"
      ],
      "confidence": "high",
      "notes": "Stamp duty rate (commonly 10% of one month's rent) not verified on opened page.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_PROP_RENT_RECEIPTS",
      "country": "PT",
      "area": "property",
      "title": "Electronic rent receipts or Modelo 44 may require review",
      "meaning": "Landlords issue an e-receipt per rent payment; exempt landlords (65+, or low rent without e-mailbox) file Modelo 44 by end of February.",
      "when": {
        "all": {
          "rentsOutProperty": [
            "long_term"
          ]
        }
      },
      "due": {
        "kind": "annual",
        "on": [
          2,
          28
        ]
      },
      "dueText": "A receipt for each rent payment; Modelo 44, for landlords exempt from receipts, by the end of February.",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/apoio_ao_contribuinte/Cidadaos/Casa_e_propriedades/Arrendamento/Recibos/Paginas/default.aspx"
      ],
      "confidence": "high",
      "notes": "Use last day of February in leap years.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_PROP_RENTAL_INCOME_TAX",
      "country": "PT",
      "area": "property",
      "title": "Rental income declaration may require review",
      "meaning": "Portuguese rents go on Anexo F of the IRS return; residential rents are taxed at 25%, reduced to 15/10/5% for 5/10/20-year leases.",
      "when": {
        "all": {
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
              6,
              30
            ]
          }
        ]
      },
      "dueText": "With the yearly IRS return, April 1 to June 30.",
      "authority": "Autoridade Tributaria",
      "consequence": "Assessment, interest, fines.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/cirs_rep/Pages/irs72.aspx"
      ],
      "confidence": "high",
      "notes": "Non-resident rate interplay complex; reductions denied for post-2024 leases far above rent caps.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_PROP_ALOJAMENTO_LOCAL",
      "country": "PT",
      "area": "property",
      "title": "Short-term rental (AL) compliance may require review",
      "meaning": "Short-term lets need an AL registration, liability insurance, SIBA guest reports within 3 days, tourist tax and tax registration.",
      "when": {
        "all": {
          "rentsOutProperty": [
            "short_term"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Guest report within 3 days of check-in; changes to municipality within 10 days.",
      "authority": "Camara Municipal; Turismo de Portugal; AT",
      "consequence": "Fines up to EUR 35,000; registration cancellation.",
      "sources": [
        "https://chekin.com/pt/blog/registo-alojamento-local/",
        "https://observador.pt/2026/06/11/camaras-municipais-ja-cancelaram-mais-de-10-mil-licencas-de-alojamento-local-por-inatividade-ou-incumprimento-de-seguros/"
      ],
      "confidence": "low",
      "notes": "Vendor source; municipal rules and containment zones vary.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_PROP_CONDOMINIUM",
      "country": "PT",
      "area": "property",
      "title": "Condominium charges and reserve fund may require review",
      "meaning": "Apartment owners pay charges set by the owners' assembly, plus at least 10% into a mandatory reserve fund.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "propertyType": [
            "apartment"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Condominium administration",
      "consequence": "Debt recovery; assembly minutes are enforceable.",
      "sources": [
        "https://www.doutorfinancas.pt/vida-e-familia/habitacao/fundo-comum-de-reserva-do-condominio-o-que-e/",
        "https://diariodarepublica.pt/dr/detalhe/decreto-lei/268-1994-624624"
      ],
      "confidence": "medium",
      "notes": "DL 268/94 as amended by Lei 8/2022.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_CO_IRC_MODELO22",
      "country": "PT",
      "area": "corporate",
      "title": "Corporate tax return (Modelo 22) may require review",
      "meaning": "A Portuguese company files its IRC return for the prior year by end of May; extended to 19 June in 2026.",
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
          5,
          31
        ]
      },
      "dueText": "Each year by May 31.",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines, ex officio assessment.",
      "sources": [
        "https://invoicexpress.com/blog/calendario-fiscal-junho/",
        "https://invoicexpress.com/blog/prorrogacao-prazos-irc-ies/",
        "https://occ.pt/pt-pt/noticias/e-agora-ies"
      ],
      "confidence": "high",
      "notes": "Check yearly for despacho extensions (2025: 30 Jun; 2026: 19 Jun).",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_CO_IES",
      "country": "PT",
      "area": "corporate",
      "title": "Annual accounts filing (IES) may require review",
      "meaning": "Companies file the IES with annual accounts by 15 July.",
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
          7,
          15
        ]
      },
      "dueText": "Each year by July 15.",
      "authority": "AT / IRN / INE / Banco de Portugal",
      "consequence": "Fines; accounts not deposited.",
      "sources": [
        "https://occ.pt/pt-pt/noticias/e-agora-ies",
        "https://invoicexpress.com/blog/prorrogacao-prazos-irc-ies/"
      ],
      "confidence": "high",
      "notes": "2025 extended to 25 July. Shareholder approval of accounts (commonly by 31 March) not verified.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_CO_RCBE_UPDATE",
      "country": "PT",
      "area": "corporate",
      "title": "Beneficial-owner update may require review",
      "meaning": "Changes in who owns or controls the company must be updated in the RCBE within 30 days.",
      "when": {
        "all": {
          "hasCompany": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "ownershipChangeDate",
        "days": 30
      },
      "dueText": "30 days after the date ownership changed.",
      "authority": "IRN (RCBE)",
      "consequence": "Fines and restrictions (not verified).",
      "sources": [
        "https://apcmc.pt/legislacao/rcbe-registo-central-do-beneficiario-efetivo-confirmacao-anual-ate-31-de-dezembro/",
        "https://portal.occ.pt/sites/default/files/public/2023-11/Guia_Pratico_RCBEa.pdf"
      ],
      "confidence": "high",
      "notes": "Penalty detail low confidence.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_CO_RCBE_ANNUAL",
      "country": "PT",
      "area": "corporate",
      "title": "Annual beneficial-owner confirmation may require review",
      "meaning": "Companies confirm RCBE data once a year by 31 December, or through the IES.",
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
          12,
          31
        ]
      },
      "dueText": "Each year by December 31.",
      "authority": "IRN (RCBE)",
      "consequence": "Fines and restrictions (not verified).",
      "sources": [
        "https://apcmc.pt/legislacao/rcbe-registo-central-do-beneficiario-efetivo-confirmacao-anual-ate-31-de-dezembro/"
      ],
      "confidence": "high",
      "notes": "Not needed if updated earlier that year.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_CO_CERTIFIED_ACCOUNTANT",
      "country": "PT",
      "area": "corporate",
      "title": "Certified accountant requirement may require review",
      "meaning": "Commercial companies must keep organised accounts signed by a contabilista certificado from incorporation.",
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
      "authority": "AT; OCC",
      "consequence": "Returns cannot be validly filed; fines.",
      "sources": [
        "https://www.crncontabilidade.pt/crn-contabilidade/contabilista-certificado-toc"
      ],
      "confidence": "medium",
      "notes": "Sole traders: above EUR 200k turnover or by option.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_TAX_RESIDENCY_TEST",
      "country": "PT",
      "area": "tax",
      "title": "Tax residency status may require review",
      "meaning": "More than 183 days in Portugal in any 12-month period, or a home kept as habitual residence, makes a person tax resident and taxable on worldwide income.",
      "when": {
        "all": {
          "livesInPortugalPartYear": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Ongoing; there is no single date.",
      "authority": "Autoridade Tributaria",
      "consequence": "Wrong filing status; double taxation.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/irs/ra/Pages/irsra16-0512.aspx",
        "https://mcs.pt/tax-residence-in-portugal-understanding-when-living-working-or-investing-makes-you-a-tax-resident/"
      ],
      "confidence": "high",
      "notes": "US citizens still file US returns; treaties with US and Canada apply.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_TAX_IRS_RETURN",
      "country": "PT",
      "area": "tax",
      "title": "Annual IRS return may require review",
      "meaning": "File the IRS return for the prior year between 1 April and 30 June; pay by 31 August.",
      "when": {
        "all": {
          "isTaxResident": [
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
              6,
              30
            ]
          }
        ]
      },
      "dueText": "File April 1 to June 30; pay any tax due by August 31.",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines, assessment, interest.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/apoio_ao_contribuinte/Cidadaos/Rendimentos/Estrangeiro/Paginas/default.aspx",
        "https://crncontabilidade.pt/blog/calendario-irs-2026/"
      ],
      "confidence": "high",
      "notes": "Non-residents with Portuguese income also file.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_TAX_FOREIGN_INCOME_ACCOUNTS",
      "country": "PT",
      "area": "tax",
      "title": "Foreign income and accounts reporting may require review",
      "meaning": "Residents report worldwide income on Anexo J and list all foreign bank and securities accounts in Quadro 11.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ],
          "hasForeignIncomeOrAccounts": [
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
              6,
              30
            ]
          }
        ]
      },
      "dueText": "With the yearly IRS return, April 1 to June 30.",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines; lost foreign tax credit.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/apoio_ao_contribuinte/Cidadaos/Rendimentos/Estrangeiro/Paginas/default.aspx"
      ],
      "confidence": "high",
      "notes": "",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_TAX_HOUSEHOLD_INVOICES",
      "country": "PT",
      "area": "tax",
      "title": "Household and e-Fatura checks may require review",
      "meaning": "Confirm household composition by 15 January and validate deductible invoices on e-Fatura by about 25 February.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "installments",
        "dates": [
          [
            1,
            15
          ],
          [
            2,
            25
          ]
        ]
      },
      "dueText": "Household details by January 15; e-Fatura invoice checks by February 25.",
      "authority": "Autoridade Tributaria",
      "consequence": "Lost deductions.",
      "sources": [
        "https://crncontabilidade.pt/blog/calendario-irs-2026/"
      ],
      "confidence": "medium",
      "notes": "Source gives 25 and 26 Feb.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_TAX_IFICI",
      "country": "PT",
      "area": "tax",
      "title": "IFICI regime application may require review",
      "meaning": "A qualifying new resident not resident in the prior 5 years registers by 15 January of the year after arrival to get a 20% rate on qualifying work income.",
      "when": {
        "all": {
          "isTaxResident": [
            "yes"
          ],
          "becameResidentLastYear": [
            "yes"
          ],
          "worksInQualifyingRole": [
            "yes"
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
      "dueText": "Each year by January 15.",
      "authority": "AT with AICEP/FCT/ANI/IAPMEI/Startup Portugal",
      "consequence": "Normal progressive rates apply.",
      "sources": [
        "https://www.ey.com/pt_pt/insights/workforce/regulamentacao-sobre-o-incentivo-fiscal-a-investigacao-cientifica-e-inovacao",
        "https://www.dnoticias.pt/2025/3/31/443727-trabalhadores-tem-ate-hoje-para-se-inscreverem-no-regime-fiscal-para-novos-residentes/",
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/legislacao/diplomas_legislativos/Documents/Portaria_352_2024_1.pdf"
      ],
      "confidence": "high",
      "notes": "Portaria 352/2024. Pensions not covered.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_TAX_NHR_LEGACY",
      "country": "PT",
      "area": "tax",
      "title": "NHR 10-year window may require review",
      "meaning": "Existing NHR holders keep the regime for 10 consecutive years, only in years they are resident.",
      "when": {
        "all": {
          "hasNHR": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "NHR lasts 10 years from the year it started.",
      "authority": "Autoridade Tributaria",
      "consequence": "Normal rates after expiry.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/irs/ra/Pages/irsra16-0512.aspx"
      ],
      "confidence": "high",
      "notes": "Closed to new entrants after 2023 (transitional cases aside).",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_VEH_IUC",
      "country": "PT",
      "area": "vehicle",
      "title": "IUC vehicle tax may require review",
      "meaning": "In 2026 IUC is paid by the end of the registration month; from 2027 in October (July and October over EUR 500); from 2028 in April/July/October tiers.",
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
      "dueText": "In 2026, by the end of the vehicle's registration month. From 2027: October (or July and October above EUR 500). From 2028: April, July and October by amount.",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines and interest.",
      "sources": [
        "https://www.gov.pt/pt/servicos/pagar-o-imposto-unico-de-circulacao-iuc-",
        "https://invoicexpress.com/blog/iuc-tudo-sobre-imposto-unico-circulacao/",
        "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/legislacao/diplomas_legislativos/Documents/decreto-lei-161-2026.pdf"
      ],
      "confidence": "high",
      "notes": "DL 161/2026. Thresholds are per taxpayer across all vehicles on 1 Jan. Day-of-month for 2027+ assumed end of month; verify in DL text.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_VEH_IPO",
      "country": "PT",
      "area": "vehicle",
      "title": "Vehicle inspection (IPO) may require review",
      "meaning": "Cars are inspected at 4 years, then every 2 years to 8 years, then yearly, in the month of first registration.",
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
      "dueText": "At 4, 6 and 8 years from first registration, then every year; up to 3 months early.",
      "authority": "IMT",
      "consequence": "Serious traffic offence fine; insurance issues.",
      "sources": [
        "https://caetano.pt/blog/inspecao-automovel/"
      ],
      "confidence": "medium",
      "notes": "Light passenger cars (M1) only.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_VEH_INSURANCE",
      "country": "PT",
      "area": "vehicle",
      "title": "Motor liability insurance may require review",
      "meaning": "Every vehicle on the road needs third-party liability insurance with the certificate in the car.",
      "when": {
        "all": {
          "ownsVehicle": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "policyRenewalDate"
      },
      "dueText": "On your policy's renewal date.",
      "authority": "ASF; police",
      "consequence": "EUR 500-2,500 fine, licence points, seizure, full liability.",
      "sources": [
        "https://postal.pt/auto/falta-lhe-isto-no-carro-prepare-se-para-pontos-perdidos-coimas-de-2-500e-e-carro-apreendido/",
        "https://diariodarepublica.pt/dr/detalhe/decreto-lei/291-2007-640637"
      ],
      "confidence": "high",
      "notes": "Fine amounts medium.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_VEH_DRIVING_LICENCE",
      "country": "PT",
      "area": "vehicle",
      "title": "US or Canadian driving licence use may require review",
      "meaning": "Visitors may drive on a foreign licence up to 185 days; residents may need to exchange at IMT within 90 days of the permit, or may keep using it under 60 if issued under 15 years ago (sources differ).",
      "when": {
        "all": {
          "residencyStatus": [
            "temporary_resident",
            "permanent_resident",
            "golden_visa"
          ],
          "drivesInPortugal": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "permitIssueDate",
        "days": 90
      },
      "dueText": "90 days after the date your residence permit was issued.",
      "authority": "IMT",
      "consequence": "Driving without a valid licence; insurance problems.",
      "sources": [
        "https://www.imt-ip.pt/condutores/reconhecimento/troca-de-titulo-de-conducao-estrangeiro/paises-aderentes-as-convencoes-e-outras-situacoes/",
        "https://www.cgd.pt/Site/Saldo-Positivo/mobilidade/Pages/trocar-carta-conducao-estrangeira-para-portuguesa.aspx"
      ],
      "confidence": "low",
      "notes": "Sources conflict; IMT country-list PDFs not opened. Default to the conservative 90-day reminder.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EMP_DOMESTIC_REGISTRATION",
      "country": "PT",
      "area": "employment",
      "title": "Domestic worker registration may require review",
      "meaning": "Report a domestic worker's hire to Seguranca Social before work starts and the end of the job by the 10th of the following month.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "employmentStartDate"
      },
      "dueText": "When the job starts; the end of a job by the 10th of the following month.",
      "authority": "Instituto da Seguranca Social",
      "consequence": "Undeclared-work offences; contributions keep accruing.",
      "sources": [
        "https://www.seg-social.pt/ptss/pssd/documento/cmc1xnoen00dakl2y9vd3tedj",
        "https://www.occ.pt/sites/default/files/public/2025-12/CICLOSS03a.pdf"
      ],
      "confidence": "high",
      "notes": "From 2026 admission must be via Seguranca Social Direta.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EMP_DOMESTIC_CONTRIBUTIONS",
      "country": "PT",
      "area": "employment",
      "title": "Monthly domestic-staff contributions may require review",
      "meaning": "Pay social security contributions for domestic staff between the 1st and 25th of the following month.",
      "when": {
        "all": {
          "hasEmployees": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "monthly",
        "day": 25
      },
      "dueText": "Between the 1st and the 25th of the following month.",
      "authority": "Instituto da Seguranca Social",
      "consequence": "Default interest; enforcement.",
      "sources": [
        "https://www.seg-social.pt/ptss/pssd/documento/cmc1xnoen00dakl2y9vd3tedj",
        "https://www.ey.com/content/dam/ey-unified-site/ey-com/pt-pt/technical/tax-alerts/documents/ey-tax-alert-alteracoes-codigo-contributivo-01-26.pdf"
      ],
      "confidence": "high",
      "notes": "2026 rates: 28.3% conventional base (18.9% employer, 9.4% worker) or 33.3% on real pay.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EMP_CHRISTMAS_SUBSIDY",
      "country": "PT",
      "area": "employment",
      "title": "Christmas subsidy payment may require review",
      "meaning": "Domestic workers are owed one extra month's pay by 15 December.",
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
          15
        ]
      },
      "dueText": "Each year by December 15.",
      "authority": "ACT",
      "consequence": "Labour claims and fines.",
      "sources": [
        "https://www.doutorfinancas.pt/vida-e-familia/emprego-domestico-direitos-e-deveres-dos-trabalhadores-e-empregadores/",
        "https://diariodarepublica.pt/dr/detalhe/decreto-lei/235-1992-220346"
      ],
      "confidence": "medium",
      "notes": "Pro rata in first and last year.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EMP_HOLIDAY_SUBSIDY",
      "country": "PT",
      "area": "employment",
      "title": "Holiday subsidy payment may require review",
      "meaning": "An extra amount equal to holiday pay is due before the worker's annual leave.",
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
      "dueText": "Before the employee's holiday.",
      "authority": "ACT",
      "consequence": "Labour claims and fines.",
      "sources": [
        "https://www.doutorfinancas.pt/vida-e-familia/emprego-domestico-direitos-e-deveres-dos-trabalhadores-e-empregadores/"
      ],
      "confidence": "medium",
      "notes": "22 working days of leave per year.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EMP_ACCIDENT_INSURANCE",
      "country": "PT",
      "area": "employment",
      "title": "Workplace accident insurance for domestic staff may require review",
      "meaning": "Employers must insure domestic workers for work and commuting accidents, whatever the hours.",
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
      "dueText": "Ongoing; there is no single date.",
      "authority": "ASF; ACT",
      "consequence": "Employer liable for accident costs; fines.",
      "sources": [
        "https://www.doutorfinancas.pt/vida-e-familia/emprego-domestico-direitos-e-deveres-dos-trabalhadores-e-empregadores/"
      ],
      "confidence": "medium",
      "notes": "Not covered in the Seguranca Social guide.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EST_WILL",
      "country": "PT",
      "area": "estate",
      "title": "Portuguese will and choice of law may require review",
      "meaning": "Without a choice-of-law clause, a Portugal resident's estate generally follows Portuguese law and forced heirship; a notarial will can choose the law of nationality.",
      "when": {
        "all": {
          "ownsProperty": [
            "yes"
          ],
          "hasPortugueseWill": [
            "no"
          ]
        }
      },
      "due": {
        "kind": "ongoing"
      },
      "dueText": "Review on move, marriage, birth, property purchase.",
      "authority": "Notario; EU Reg. 650/2012",
      "consequence": "Unintended heirs; partners and stepchildren may inherit nothing.",
      "sources": [
        "https://www.portugalresidencyadvisors.com/pt-br/impostos-em-portugal-testamentos/",
        "https://www.notarios.pt"
      ],
      "confidence": "medium",
      "notes": "US/Canadian wills may also be recognised; coordinate with home-country planning.",
      "reviewedByCounsel": false
    },
    {
      "id": "PT_EST_INHERITANCE_DECLARATION",
      "country": "PT",
      "area": "estate",
      "title": "Inheritance declaration (Modelo 1) may require review",
      "meaning": "The head of the estate files Modelo 1 by the end of the third month after death; close family is exempt from the 10% stamp duty, others pay it.",
      "when": {
        "all": {
          "lifeEvent": [
            "death_in_family"
          ],
          "estateHasPortugueseAssets": [
            "yes"
          ]
        }
      },
      "due": {
        "kind": "relative",
        "anchor": "dateOfDeath",
        "endOfMonthAfter": 3
      },
      "dueText": "By the end of the third month after the death.",
      "authority": "Autoridade Tributaria",
      "consequence": "Fines and interest; delays registering property.",
      "sources": [
        "https://info.portaldasfinancas.gov.pt/pt/apoio_ao_contribuinte/Cidadaos/Dados_pessoais_familia/Familia/Obito/Paginas/default.aspx"
      ],
      "confidence": "high",
      "notes": "0.8% stamp duty on real estate for exempt heirs not verified.",
      "reviewedByCounsel": false
    }
  ]
};
