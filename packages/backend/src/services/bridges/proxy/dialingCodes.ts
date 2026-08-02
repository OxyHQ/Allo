/**
 * Country calling code → ISO 3166-1 alpha-2, for the middle step of §8.3 rule 2.
 *
 * ## Shared codes are deliberately absent
 *
 * `+1` covers the United States, Canada and about twenty Caribbean countries;
 * `+7` covers Russia and Kazakhstan; `+590`, `+599` and `+262` each cover
 * several territories. Telling them apart needs area-code tables that change,
 * and a WRONG country here is worse than no answer: the country is frozen onto
 * the lease and never recalculated (§8.3 rule 2), so a bad guess is a user
 * permanently egressing from the wrong place — the precise signal the whole
 * design exists to avoid emitting.
 *
 * An absent code therefore returns `undefined` and the caller falls through to
 * the next source. Falling through is safe; guessing is not.
 *
 * This table is a convenience for the common case, not an authority on
 * numbering plans.
 */
const DIALING_CODE_TO_COUNTRY: Readonly<Record<string, string>> = Object.freeze({
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "36": "HU",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "48": "PL",
  "49": "DE",
  "51": "PE",
  "52": "MX",
  "53": "CU",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "58": "VE",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "93": "AF",
  "94": "LK",
  "95": "MM",
  "98": "IR",
  "212": "MA",
  "213": "DZ",
  "216": "TN",
  "218": "LY",
  "220": "GM",
  "221": "SN",
  "222": "MR",
  "223": "ML",
  "224": "GN",
  "225": "CI",
  "226": "BF",
  "227": "NE",
  "228": "TG",
  "229": "BJ",
  "230": "MU",
  "231": "LR",
  "232": "SL",
  "233": "GH",
  "234": "NG",
  "235": "TD",
  "236": "CF",
  "237": "CM",
  "238": "CV",
  "239": "ST",
  "240": "GQ",
  "241": "GA",
  "242": "CG",
  "243": "CD",
  "244": "AO",
  "245": "GW",
  "248": "SC",
  "249": "SD",
  "250": "RW",
  "251": "ET",
  "252": "SO",
  "253": "DJ",
  "254": "KE",
  "255": "TZ",
  "256": "UG",
  "257": "BI",
  "258": "MZ",
  "260": "ZM",
  "261": "MG",
  "263": "ZW",
  "264": "NA",
  "265": "MW",
  "266": "LS",
  "267": "BW",
  "268": "SZ",
  "269": "KM",
  "291": "ER",
  "350": "GI",
  "351": "PT",
  "352": "LU",
  "353": "IE",
  "354": "IS",
  "355": "AL",
  "356": "MT",
  "357": "CY",
  "358": "FI",
  "359": "BG",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "373": "MD",
  "374": "AM",
  "375": "BY",
  "376": "AD",
  "377": "MC",
  "378": "SM",
  "380": "UA",
  "381": "RS",
  "382": "ME",
  "385": "HR",
  "386": "SI",
  "387": "BA",
  "389": "MK",
  "420": "CZ",
  "421": "SK",
  "423": "LI",
  "500": "FK",
  "501": "BZ",
  "502": "GT",
  "503": "SV",
  "504": "HN",
  "505": "NI",
  "506": "CR",
  "507": "PA",
  "509": "HT",
  "591": "BO",
  "592": "GY",
  "593": "EC",
  "595": "PY",
  "597": "SR",
  "598": "UY",
  "670": "TL",
  "673": "BN",
  "675": "PG",
  "679": "FJ",
  "852": "HK",
  "853": "MO",
  "855": "KH",
  "856": "LA",
  "880": "BD",
  "886": "TW",
  "960": "MV",
  "961": "LB",
  "962": "JO",
  "963": "SY",
  "964": "IQ",
  "965": "KW",
  "966": "SA",
  "967": "YE",
  "968": "OM",
  "970": "PS",
  "971": "AE",
  "972": "IL",
  "973": "BH",
  "974": "QA",
  "975": "BT",
  "976": "MN",
  "977": "NP",
  "992": "TJ",
  "993": "TM",
  "994": "AZ",
  "995": "GE",
  "996": "KG",
  "998": "UZ",
});

/** Longest code first, so `+350` resolves to Gibraltar and not to something shorter. */
const CODES_LONGEST_FIRST: readonly string[] = Object.keys(DIALING_CODE_TO_COUNTRY).sort(
  (a, b) => b.length - a.length,
);

/**
 * The country a phone number dials into, when that can be known unambiguously.
 *
 * The number must be in international form. A national number carries no country
 * at all — `600 111 222` is a valid subscriber number in several countries — and
 * assuming one would be the same wrong guess the shared codes are excluded for.
 */
export function countryFromDialingPrefix(phoneNumber: string): string | undefined {
  const digits = phoneNumber.replace(/[\s()-]/g, "");
  if (!digits.startsWith("+")) return undefined;

  const national = digits.slice(1);
  if (!/^[0-9]+$/.test(national)) return undefined;

  for (const code of CODES_LONGEST_FIRST) {
    if (national.startsWith(code)) return DIALING_CODE_TO_COUNTRY[code];
  }
  return undefined;
}
