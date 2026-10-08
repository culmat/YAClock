// Astronomical calculations: sun position + moon phase.
// Simplified port of Meeus 1998. Accurate to ~1 arcminute for sun, ~1° for moon phase.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const SYNODIC_MONTH = 29.530588853;
const REF_NEW_MOON_JD = 2451550.1; // 2000-01-06 18:14 UT, near a known new moon

export function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

// Returns sun's geocentric ecliptic longitude (rad), declination (rad), right ascension (rad).
function sunEcliptic(jd) {
    const n = jd - 2451545.0;
    const L = (280.460 + 0.9856474 * n) * DEG;
    const g = (357.528 + 0.9856003 * n) * DEG;
    const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    const sinLambda = Math.sin(lambda);
    const dec = Math.asin(Math.sin(eps) * sinLambda);
    const ra = Math.atan2(Math.cos(eps) * sinLambda, Math.cos(lambda));
    return { lambda, dec, ra, eps };
}

// Local sidereal time (rad) at given longitude (rad) and JD.
function localSiderealTime(jd, lonRad) {
    const T = (jd - 2451545.0) / 36525;
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) +
               0.000387933 * T * T - T * T * T / 38710000;
    gmst = ((gmst % 360) + 360) % 360;
    return gmst * DEG + lonRad;
}

// Solar altitude (rad) and azimuth (rad, 0=N, increases east) for observer at (lat,lon) rad.
export function sunPosition(date, latDeg, lonDeg) {
    const jd = julianDate(date);
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG;
    const { dec, ra } = sunEcliptic(jd);
    const lst = localSiderealTime(jd, lon);
    const H = lst - ra;
    const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    const alt = Math.asin(sinAlt);
    const az = Math.atan2(-Math.cos(dec) * Math.sin(H),
                          Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H));
    return { altitude: alt, azimuth: az, declination: dec };
}

// Approximate sunrise / sunset / solar noon times (Date objects, today, at observer lat/lon).
export function sunTimes(date, latDeg, lonDeg) {
    const lat = latDeg * DEG;
    const jd0 = Math.floor(julianDate(date) - 0.5) + 0.5;
    const { dec } = sunEcliptic(jd0 + 0.5);
    const cosH0 = (Math.sin(-0.833 * DEG) - Math.sin(lat) * Math.sin(dec)) /
                  (Math.cos(lat) * Math.cos(dec));
    let rise = null, set = null, noon;
    const noonJd = jd0 + 0.5 - lonDeg / 360;
    noon = new Date((noonJd - 2440587.5) * 86400000);
    if (cosH0 >= -1 && cosH0 <= 1) {
        const H0 = Math.acos(cosH0) * RAD / 360;
        rise = new Date((noonJd - H0 - 2440587.5) * 86400000);
        set = new Date((noonJd + H0 - 2440587.5) * 86400000);
    }
    return { sunrise: rise, sunset: set, solarNoon: noon };
}

// Moon phase: returns { phase: 0..1, illumination: 0..1, age: days }
// phase 0 = new moon, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter.
export function moonPhase(date) {
    const jd = julianDate(date);
    const age = ((jd - REF_NEW_MOON_JD) % SYNODIC_MONTH + SYNODIC_MONTH) % SYNODIC_MONTH;
    const phase = age / SYNODIC_MONTH;
    const illumination = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
    return { phase, illumination, age };
}

// Returns daylight arc as [startAngle, endAngle] in radians around the 24h dial
// (angle 0 = midnight at top, increasing clockwise like the 12h clock).
// Used by the face shader to render the daylight band.
export function daylightArc(date, latDeg, lonDeg) {
    const { sunrise, sunset } = sunTimes(date, latDeg, lonDeg);
    if (!sunrise || !sunset) return null;
    const dayMs = 86400000;
    const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
    const a = (sunrise - startOfDay) / dayMs * 2 * Math.PI;
    const b = (sunset - startOfDay) / dayMs * 2 * Math.PI;
    return [a, b];
}
