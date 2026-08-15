import * as THREE from 'three';

type Extras = { object: THREE.Group; disposables: { dispose(): void }[] };

/** A perforated-metal texture: bright dots (holes catching light) on transparent. */
function perforationTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,240,200,0.85)';
  for (let y = 5; y < 64; y += 11) {
    for (let x = 5; x < 64; x += 11) {
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(70, 7);
  return t;
}

/**
 * Al-Awwal Park (Riyadh) — Al-Nassr's open ground: a gold perforated-metal skin
 * wrapping the exterior, and a big roof that bends over the West (main) stand.
 */
export function buildAlAwwalExtras(outerA: number, outerB: number, topY: number): Extras {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];
  const ra = outerA * 1.03;
  const rb = outerB * 1.03;

  // Dark bronze perforated outer wall, hugging the back of the seating bowl so it
  // stays hidden behind the stands from inside.
  const perf = perforationTexture();
  const cladGeo = new THREE.CylinderGeometry(1, 1, 1, 112, 1, true);
  const cladMat = new THREE.MeshStandardMaterial({ color: 0x2e2620, emissive: 0x5a4420, emissiveIntensity: 0.1, emissiveMap: perf, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide });
  const clad = new THREE.Mesh(cladGeo, cladMat);
  clad.scale.set(ra, topY + 1, rb);
  clad.position.y = (topY + 1) / 2;
  group.add(clad);
  trash.push(cladGeo, cladMat, perf);

  // Wavy cream cantilever roof, springing from the TOP of the wall and cantilevering
  // in over the seats with an undulating leading edge; open over the pitch.
  const NSEG = 140;
  const NRAD = 3;
  const aIn = outerA * 0.82;
  const bIn = outerB * 0.82;
  const yOut = topY + 8;
  const yIn = topY + 11;
  const waveAmp = 2.6;
  const waves = 12;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= NSEG; i++) {
    const th = (i / NSEG) * Math.PI * 2;
    for (let j = 0; j <= NRAD; j++) {
      const s = j / NRAD;
      const ax = ra + (aIn - ra) * s;
      const bz = rb + (bIn - rb) * s;
      const y = yOut + (yIn - yOut) * s + Math.sin(th * waves) * waveAmp * s;
      verts.push(Math.cos(th) * ax, y, Math.sin(th) * bz);
    }
  }
  for (let i = 0; i < NSEG; i++) {
    for (let j = 0; j < NRAD; j++) {
      const a = i * (NRAD + 1) + j;
      const b = a + (NRAD + 1);
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  roofGeo.setIndex(idx);
  roofGeo.computeVertexNormals();
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe9e0c9, emissive: 0x4a4026, emissiveIntensity: 0.13, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  group.add(roof);
  trash.push(roofGeo, roofMat);

  // Thin support masts from the wall top up to the roof's outer edge, so the roof
  // is clearly held up while leaving open sky above the seats.
  const mastGeo = new THREE.CylinderGeometry(0.5, 0.5, 8, 6);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x3a342a, roughness: 0.6, metalness: 0.6 });
  for (let k = 0; k < 16; k++) {
    const th = (k / 16) * Math.PI * 2;
    const m = new THREE.Mesh(mastGeo, mastMat);
    m.position.set(Math.cos(th) * ra, topY + 4, Math.sin(th) * rb);
    group.add(m);
  }
  trash.push(mastGeo, mastMat);

  // --- VIP hospitality mid-tier band (Membership Lounge / board level) --------
  // Navy ring at the tier break, faced with warm glass hospitality boxes and
  // "ALAWWAL PARK" signage on the two main (sideline) stands.
  const bandY = topY * 0.6;
  const bandH = topY * 0.2;
  const bandAx = ra * 0.86;
  const bandBz = rb * 0.86;
  const boxCanvas = document.createElement('canvas');
  boxCanvas.width = 256;
  boxCanvas.height = 16;
  const bxc = boxCanvas.getContext('2d')!;
  bxc.fillStyle = '#0e1c48';
  bxc.fillRect(0, 0, 256, 16);
  for (let i = 0; i < 32; i++) {
    bxc.fillStyle = i % 2 ? 'rgba(255,225,150,0.95)' : 'rgba(255,205,110,0.7)';
    bxc.fillRect(i * 8 + 1, 4, 6, 9);
  }
  const boxTex = new THREE.CanvasTexture(boxCanvas);
  boxTex.wrapS = THREE.RepeatWrapping;
  boxTex.repeat.set(26, 1);
  const bandGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true, Math.PI * 0.16, Math.PI * 0.68);
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x0e1c48, emissive: 0xffd27a, emissiveMap: boxTex, emissiveIntensity: 0.5, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.scale.set(bandAx, bandH, bandBz);
  band.position.y = bandY;
  group.add(band);
  trash.push(bandGeo, bandMat, boxTex);
  // Navy fascia strip above the glazing.
  const fasGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true, Math.PI * 0.16, Math.PI * 0.68);
  const fasMat = new THREE.MeshStandardMaterial({ color: 0x122a5c, roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide });
  const fascia = new THREE.Mesh(fasGeo, fasMat);
  fascia.scale.set(bandAx * 1.004, bandH * 0.42, bandBz * 1.004);
  fascia.position.y = bandY + bandH * 0.62;
  group.add(fascia);
  trash.push(fasGeo, fasMat);
  // "ALAWWAL PARK" signage on both sideline (main) stands, facing the pitch.
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 256;
  signCanvas.height = 32;
  const sgc = signCanvas.getContext('2d')!;
  sgc.fillStyle = '#0b1740';
  sgc.fillRect(0, 0, 256, 32);
  sgc.fillStyle = '#ffd21e';
  sgc.font = 'bold 17px system-ui';
  sgc.textAlign = 'center';
  sgc.textBaseline = 'middle';
  sgc.fillText('ALAWWAL PARK', 128, 17);
  const signTex = new THREE.CanvasTexture(signCanvas);
  const signGeo = new THREE.PlaneGeometry(bandAx * 0.55, bandH * 0.66);
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide, transparent: true });
  for (const sgn of [1]) {
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, bandY + bandH * 0.08, sgn * bandBz * 1.01);
    sign.rotation.y = sgn > 0 ? Math.PI : 0;
    group.add(sign);
  }
  trash.push(signGeo, signMat, signTex);

  // --- Premium terrace couches (Terrace / Sports Terrace / Membership Lounge) -
  // Navy leather sofas + round tables at the front lip of the hospitality level,
  // clustered at midfield on both main stands, looking over the pitch.
  const couchMat = new THREE.MeshStandardMaterial({ color: 0x1a2340, roughness: 0.55, metalness: 0.1 });
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x6b5636, roughness: 0.5, metalness: 0.2 });
  const seatGeo = new THREE.BoxGeometry(4.2, 0.7, 1.8);
  const backGeo = new THREE.BoxGeometry(4.2, 1.3, 0.4);
  const tableGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.55, 12);
  trash.push(couchMat, tableMat, seatGeo, backGeo, tableGeo);
  const terraceY = bandY - bandH * 0.42;
  const terraceBz = bandBz * 0.94;
  const terraceAx = bandAx;
  for (const sgn of [1]) {
    for (let c = -2; c <= 2; c++) {
      const cg = new THREE.Group();
      const seat = new THREE.Mesh(seatGeo, couchMat);
      seat.position.y = 0.45;
      cg.add(seat);
      const back = new THREE.Mesh(backGeo, couchMat);
      back.position.set(0, 1.0, -0.7);
      cg.add(back);
      const table = new THREE.Mesh(tableGeo, tableMat);
      table.position.set(0, 0.3, 1.4);
      cg.add(table);
      cg.position.set(c * terraceAx * 0.16, terraceY, sgn * terraceBz);
      cg.rotation.y = sgn > 0 ? Math.PI : 0;
      group.add(cg);
    }
  }

  // --- Player tunnel at pitch-side midfield (main stand) ----------------------
  const tunMat = new THREE.MeshStandardMaterial({ color: 0x080d1e, emissive: 0x0b1430, emissiveIntensity: 0.5, roughness: 0.85, metalness: 0.2, side: THREE.DoubleSide });
  const mouthGeo = new THREE.BoxGeometry(7, 4, 6);
  const mouth = new THREE.Mesh(mouthGeo, tunMat);
  const innerFrontZ = rb * 0.66;
  mouth.position.set(0, 2, innerFrontZ + 1);
  group.add(mouth);
  const hCanvas = document.createElement('canvas');
  hCanvas.width = 128;
  hCanvas.height = 24;
  const hxc = hCanvas.getContext('2d')!;
  hxc.fillStyle = '#0b1740';
  hxc.fillRect(0, 0, 128, 24);
  hxc.fillStyle = '#ffd21e';
  hxc.font = 'bold 12px system-ui';
  hxc.textAlign = 'center';
  hxc.textBaseline = 'middle';
  hxc.fillText('ALAWWAL PARK', 64, 13);
  const hTex = new THREE.CanvasTexture(hCanvas);
  const headGeo = new THREE.PlaneGeometry(7, 1.4);
  const headMat = new THREE.MeshBasicMaterial({ map: hTex, side: THREE.DoubleSide });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.set(0, 4.5, innerFrontZ - 2);
  head.rotation.y = 0;
  group.add(head);
  trash.push(mouthGeo, tunMat, headGeo, headMat, hTex);

  return { object: group, disposables: trash };
}

/**
 * Kingdom Arena (Riyadh) - Al-Hilal's fully-CLOSED indoor box. Four dark opaque
 * walls and a dark ceiling seal the arena; interior lights + hanging light rigs
 * illuminate it (no daylight); giant end "AL HILAL" LED walls, a blue LED ribbon
 * and the four-sided HILAL jumbotron fill it. The simulator uses interior camera
 * shots for this template so the viewer sits inside the box. Auto-sized to seats.
 */
export function buildKingdomArenaExtras(outerA: number, outerB: number, topY: number): Extras {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];
  const bx = outerA * 1.5;
  const bz = outerB * 1.6;
  const roofTop = topY + 22;

  // Closed dark box: four opaque walls + a dark ceiling seal the arena.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x14161c, emissive: 0x090b12, emissiveIntensity: 0.16, roughness: 0.9, metalness: 0.3, side: THREE.DoubleSide });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x0c0d12, emissive: 0x060709, emissiveIntensity: 0.25, roughness: 0.95, metalness: 0.3, side: THREE.DoubleSide });
  const xWallGeo = new THREE.PlaneGeometry(bz * 2, roofTop);
  const zWallGeo = new THREE.PlaneGeometry(bx * 2, roofTop);
  const roofGeo = new THREE.PlaneGeometry(bx * 2, bz * 2);
  const mk = (geo: THREE.PlaneGeometry, x: number, y: number, z: number, ry: number, rx: number, mat: THREE.Material): void => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    group.add(m);
  };
  mk(xWallGeo, bx, roofTop / 2, 0, Math.PI / 2, 0, wallMat);
  mk(xWallGeo, -bx, roofTop / 2, 0, Math.PI / 2, 0, wallMat);
  mk(zWallGeo, 0, roofTop / 2, bz, 0, 0, wallMat);
  mk(zWallGeo, 0, roofTop / 2, -bz, 0, 0, wallMat);
  mk(roofGeo, 0, roofTop, 0, 0, Math.PI / 2, ceilMat);
  trash.push(xWallGeo, zWallGeo, roofGeo, wallMat, ceilMat);

  // Interior arena lighting (no daylight in a sealed hall).
  for (const [lx, lz] of [[0, 0], [bx * 0.4, bz * 0.4], [-bx * 0.4, bz * 0.4], [bx * 0.4, -bz * 0.4], [-bx * 0.4, -bz * 0.4]]) {
    const pl = new THREE.PointLight(0xdfe8ff, 1.0, bx * 3, 1.5);
    pl.position.set(lx, roofTop - 3, lz);
    group.add(pl);
  }
  // Hanging light rigs under the ceiling.
  const lpos: number[] = [];
  for (let ix = 0; ix < 16; ix++) for (let iz = 0; iz < 12; iz++) lpos.push((ix / 15 - 0.5) * bx * 1.9, roofTop - 1.5, (iz / 11 - 0.5) * bz * 1.9);
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
  const lmat = new THREE.PointsMaterial({ size: 2.0, color: 0xfff2d2, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  const lights = new THREE.Points(lgeo, lmat);
  lights.frustumCulled = false;
  group.add(lights);
  trash.push(lgeo, lmat);

  // Blue LED ribbon around the top of the bowl.
  const ledGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x2b6fe0, side: THREE.DoubleSide });
  const led = new THREE.Mesh(ledGeo, ledMat);
  led.rotation.y = Math.PI / 8;
  led.scale.set(outerA * 1.2, 2.0, outerB * 1.2);
  led.position.y = topY + 1;
  group.add(led);
  trash.push(ledGeo, ledMat);

  // ===== "Stadium Dominance" LED portals framing each goal (Rotana spec) =====
  // Each goal end is framed by two full-height corner LED tower-pillars bridged
  // by a wide top LED banner, with a scoreboard screen + club banner hanging in
  // the middle. Emissive so they glow in the dark box (and bloom on high).
  const disposeTex: THREE.Texture[] = [];
  const disposeGeo: THREE.BufferGeometry[] = [];
  const disposeMat: THREE.Material[] = [];
  const ledPanelTex = (label?: string): THREE.CanvasTexture => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, '#1b52c8');
    grd.addColorStop(0.5, '#2f7ae0');
    grd.addColorStop(1, '#123a94');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 64);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let y = 0; y < 64; y += 3) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
    if (label) { g.fillStyle = 'rgba(255,255,255,0.94)'; g.font = 'bold 20px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 64, 32); }
    const t = new THREE.CanvasTexture(c);
    disposeTex.push(t);
    return t;
  };
  const ledMatFor = (label: string | undefined, inten: number): THREE.MeshStandardMaterial => {
    const tx = ledPanelTex(label);
    const m = new THREE.MeshStandardMaterial({ color: 0x0a1430, emissive: 0xffffff, emissiveMap: tx, emissiveIntensity: inten, map: tx, roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide });
    disposeMat.push(m);
    return m;
  };
  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry: number): void => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    group.add(m);
    disposeGeo.push(geo);
  };

  // Broadcast-style scoreboard face: dark screen, mini live pitch, score bug.
  const scoreTex = ((): THREE.CanvasTexture => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 112;
    const g = c.getContext('2d')!;
    g.fillStyle = '#060b1c';
    g.fillRect(0, 0, 256, 112);
    g.fillStyle = '#1f7a3a';
    g.fillRect(74, 8, 108, 60);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1;
    g.strokeRect(74, 8, 108, 60);
    g.beginPath(); g.moveTo(128, 8); g.lineTo(128, 68); g.stroke();
    g.beginPath(); g.arc(128, 38, 10, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#0a1c52';
    g.fillRect(28, 78, 200, 26);
    g.fillStyle = '#ffffff';
    g.font = 'bold 17px system-ui';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('AL HILAL   1 - 1', 128, 92);
    const t = new THREE.CanvasTexture(c);
    disposeTex.push(t);
    return t;
  })();
  const scoreMat = new THREE.MeshStandardMaterial({ color: 0x05070f, emissive: 0xffffff, emissiveMap: scoreTex, emissiveIntensity: 1.0, map: scoreTex, roughness: 0.4, side: THREE.DoubleSide });
  disposeMat.push(scoreMat);

  // Goal-end LED portals. Pillars stand in the PITCH-CORNER run-off (behind the
  // goal line, outside the touchline) where there is no seating, so they frame
  // the goal end without covering any stand. Pitch is 105x68 (goal x=±52.5).
  const pillarX = 58;   // just behind the goal line, in the run-off
  const pillarZ = 40;   // just outside the touchline, in the corner
  const towerH = topY + 6;
  const bannerH = 7;
  for (const sx of [1, -1]) {
    // Two slim corner pillars, from pitch level up to the top banner.
    for (const sz of [1, -1]) {
      addMesh(new THREE.BoxGeometry(4, towerH, 5), ledMatFor(undefined, 0.72), sx * pillarX, towerH / 2, sz * pillarZ, 0);
    }
    // Top banner bridging the pillars, held ABOVE the goal-end stand.
    addMesh(new THREE.BoxGeometry(3.5, bannerH, pillarZ * 2 + 5), ledMatFor('AL HILAL', 0.62), sx * pillarX, towerH + bannerH / 2, 0, 0);
    // Scoreboard hung from the banner centre, over the goal.
    addMesh(new THREE.BoxGeometry(1.6, 7.5, 15), scoreMat, sx * (pillarX - 2), topY * 0.82, 0, 0);
    // Club banner below the scoreboard, facing the pitch.
    addMesh(new THREE.PlaneGeometry(7, 12), ledMatFor('AL HILAL', 0.6), sx * (pillarX - 2.3), topY * 0.52, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
  }

  // Pitch-perimeter LED boards: a LOW RECTANGLE hugging the pitch edge. (An
  // ellipse cuts across the rectangular pitch's corners — that was the stray
  // blue arc on the grass.) Four straight boards, one per touchline/goal line.
  const perimTex = ledPanelTex();
  perimTex.wrapS = THREE.RepeatWrapping;
  perimTex.repeat.set(18, 1);
  const perimMat = new THREE.MeshStandardMaterial({ color: 0x0a1430, emissive: 0xffffff, emissiveMap: perimTex, emissiveIntensity: 0.5, roughness: 0.5, side: THREE.DoubleSide });
  disposeMat.push(perimMat);
  const boardH = 1.3;
  const bX = 54.5; // just outside the goal line
  const bZ = 36;   // just outside the touchline
  const boards: [number, number, number, number][] = [
    [bX, 0, bZ * 2, Math.PI / 2],
    [-bX, 0, bZ * 2, Math.PI / 2],
    [0, bZ, bX * 2, 0],
    [0, -bZ, bX * 2, 0],
  ];
  for (const [px, pz, len, ry] of boards) {
    addMesh(new THREE.PlaneGeometry(len, boardH), perimMat, px, boardH / 2 + 0.2, pz, ry);
  }

  trash.push(...disposeTex, ...disposeGeo, ...disposeMat);
  return { object: group, disposables: trash };
}
