// A small camera-facing surface adds a continuous accretion disc and shadow
// to the particle galaxy. Analytic profiles avoid an expensive raymarch or
// a full-screen postprocessing pass; all colors come from the landing palette.
export const BLACK_HOLE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const BLACK_HOLE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uTilt;
  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform vec3 uShadowColor;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
  }

  // Sample the gas in advected polar coordinates. Inner lanes lap the
  // outer lanes, stretching hot knots into filaments instead of rotating a
  // uniform ring. This is an art-directed optical approximation, not GR.
  float gas(float radius, float angle) {
    float omega = 0.72 * pow(2.0 / max(radius, 1.5), 1.5);
    float a = angle - uTime * omega;
    float inflow = radius + uTime * 0.035;
    vec2 advected = vec2(cos(a), sin(a)) * inflow;
    float broad = noise(advected * 2.1);
    float fine = noise(advected * 7.5 + vec2(11.0, 7.0));
    // Anisotropic noise stretches gas along the orbit. Avoid radial sine
    // bands: evenly spaced concentric lines look like a wireframe surface.
    float filaments = noise(vec2(radius * 14.0 + broad * 8.0 + uTime * 0.12,
                                 cos(a) * 3.0 + sin(a) * 4.0));
    float knots = pow(broad, 3.0) * 2.4;
    return (0.10 + 0.90 * filaments * filaments) * (0.25 + 0.75 * fine) + knots;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 12.0;
    float c = cos(uTilt);
    float s = sin(uTilt);
    p = mat2(c, -s, s, c) * p;
    float r = length(p);
    float horizon = 1.38;
    float shadow = 1.0 - smoothstep(horizon - 0.025, horizon + 0.025, r);

    vec2 disc = vec2(p.x, p.y / 0.19);
    float dr = length(disc);
    float angle = atan(disc.y, disc.x);
    float diskMask = smoothstep(1.60, 1.78, dr) * (1.0 - smoothstep(3.3, 5.5, dr));
    float innerEdge = exp(-pow((dr - 1.95) / 0.34, 2.0));
    float heat = pow(1.9 / max(dr, 1.9), 2.1);
    float beaming = 0.48 + 0.95 * (0.5 - 0.5 * cos(angle));
    float flowingGas = gas(dr, angle);
    float hotRim = exp(-pow((dr - 1.82) / 0.13, 2.0));
    float diskLight = diskMask * (heat * 0.65 + innerEdge * 1.1 + hotRim * 2.6) *
      (0.24 + flowingGas) * beaming;
    float foreground = 1.0 - smoothstep(-0.12, 0.04, p.y);
    diskLight *= 1.0 - shadow * (1.0 - foreground);

    // The secondary image samples the SAME moving gas, compressed around
    // the shadow: a bright rear arch and a much fainter underside.
    vec2 arc = vec2(p.x, (p.y - 0.04) / 0.94);
    float ar = length(arc);
    float arcAngle = atan(arc.y, arc.x);
    float sourceRadius = 1.85 + (ar - 1.58) * 4.0;
    float arcBand = exp(-pow((ar - 1.57) / 0.085, 2.0));
    float arcBeam = 0.55 + 0.75 * (0.5 - 0.5 * cos(arcAngle));
    float arcGas = 0.32 + gas(max(sourceRadius, 1.6), arcAngle);
    float rearLight = arcBand * arcGas * arcBeam *
      mix(0.045, 0.86, smoothstep(-0.2, 0.5, p.y)) * (1.0 - shadow);
    float photon = exp(-pow((r - 1.415) / 0.016, 2.0));
    float corona = exp(-max(r - horizon, 0.0) * 6.0) * (1.0 - shadow) * 0.07;

    float upperArc = mix(0.12, 1.0, smoothstep(-0.4, 0.5, p.y));
    // Analytic bloom around the hot edge only: a sharp luminous core, a
    // narrow shoulder and a faint outer halo. The shadow stays truly dark.
    float rimBloom = exp(-pow((r - 1.43) / 0.11, 2.0)) * 0.34;
    float arcBloom = exp(-pow((ar - 1.57) / 0.30, 2.0)) * 0.23 * arcGas * arcBeam;
    float diskBloom = diskMask * exp(-abs(p.y) * 3.0) * heat * 0.14;
    float bloom = (rimBloom + arcBloom * upperArc + diskBloom) * (1.0 - shadow);
    float light = diskLight + rearLight * 2.1 + photon * (0.45 + upperArc * 2.4) + corona + bloom;
    // Map emitted energy smoothly into display range. The peak approaches
    // white while its shoulders retain the original violet/pink palette.
    float hot = 1.0 - exp(-(hotRim * diskMask + rearLight + photon) * 2.6);
    vec3 emission = mix(uColor * 0.75, mix(uHotColor, vec3(1.0), 0.72), hot);
    vec3 radiance = vec3(1.0) - exp(-emission * light * 2.1);
    float coverage = max(shadow, clamp(light * 2.6, 0.0, 0.99));
    vec3 color = mix(uShadowColor, radiance, smoothstep(0.0, 0.10, light));
    float edge = 1.0 - smoothstep(5.5, 5.9, r);
    float alpha = coverage * edge * uOpacity;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
