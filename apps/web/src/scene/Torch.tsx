/**
 * The torch.
 *
 * A real cone of light the player aims.
 *
 * There is deliberately no volumetric beam. One was written and screenshotted,
 * and because the beam is always aimed where the camera is looking it was
 * always seen end-on: a bright disc in the middle of the frame with a stalk
 * under it, which read as a floating object rather than as light. §12's "no
 * information through a single channel" is met by the HUD line and the
 * subtitle (`describeTorch`), which say what the torch is doing in words.
 *
 * The beam is one `SpotLight`, and it exists only while the torch is lit.
 * ARCHITECTURE §10 budgets six dynamic lights and the reveal already runs at
 * ten (a pinned deviation), so a light that is on whenever the player is
 * holding a torch, and gone the instant they switch it off, is the only
 * version of this that is affordable.
 *
 * Nothing here decides anything. Where the beam points, how wide it is, how
 * far it reaches and how much the wildlife mind it are all `torch.ts`; this
 * draws what that model says is true.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { eyePosition, type PlayerState, type TorchState } from '@somemore/sim';
import type { RenderSettings } from '../render/ps1.js';

export interface TorchProps {
  torch: TorchState;
  player: PlayerState;
  settings: RenderSettings;
  /**
   * Where it lies when nobody has picked it up.
   *
   * It has to be *there* — on the log, next to the radio — or "pick the torch
   * up off the log" is reaching for an invisible object, which is the same
   * class of defect as an unlit sandwich: the model is right and the player
   * cannot tell.
   */
  restPosition: readonly [number, number, number];
}

export function Torch({ torch, player, settings, restPosition }: TorchProps): React.ReactElement {
  const lightRef = useRef<THREE.SpotLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);
  const bodyRef = useRef<THREE.Mesh>(null);

  const eye = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);

  /** The barrel, lying along +Z so `lookAt` aims it. */
  const bodyGeometry = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(0.021, 0.026, 0.15, 8);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }, []);
  useEffect(() => () => bodyGeometry.dispose(), [bodyGeometry]);

  // A spot light aims at a target object, which has to be wired up once the
  // refs exist rather than passed as a prop on the first render.
  useEffect(() => {
    if (lightRef.current && targetRef.current) lightRef.current.target = targetRef.current;
  }, []);

  useFrame(() => {
    const lit = torch.held && torch.on;

    const light = lightRef.current;
    const target = targetRef.current;
    const body = bodyRef.current;

    if (body) {
      body.visible = true;
      if (!torch.held) {
        // Lying on the log where somebody left it, pointing along it.
        body.position.set(restPosition[0], restPosition[1], restPosition[2]);
        body.rotation.set(0, 0.5, Math.PI / 2);
      }
    }
    if (light) light.visible = lit;
    if (!lit) return;

    eyePosition(player, eye);
    // Held at the hip and slightly out to the side, the way a torch is.
    const handX = eye.x + Math.cos(player.facing - 0.4) * 0.22;
    const handZ = eye.z + Math.sin(player.facing - 0.4) * 0.22;
    const handY = eye.y - 0.34;

    const cosPitch = Math.cos(torch.pitch);
    const dirX = Math.cos(torch.yaw) * cosPitch;
    const dirY = Math.sin(torch.pitch);
    const dirZ = Math.sin(torch.yaw) * cosPitch;

    if (light && target) {
      light.position.set(handX, handY, handZ);
      target.position.set(handX + dirX * torch.rangeM, handY + dirY * torch.rangeM, handZ + dirZ * torch.rangeM);
      target.updateMatrixWorld();
      light.angle = torch.beamAngle;
      light.distance = torch.rangeM;
      /*
       * Calibrated against the fire, which is the only other light in the
       * camp: it runs at about 11 with a decay of 1.35 and only just clears
       * the quantisation floor at the treeline (ARCHITECTURE §4.1 — below
       * about 8/255 a surface renders as nothing, not as very dark). A torch
       * has to beat that comfortably or it is a light that lights nothing,
       * which is what the first version of this was: measured at roughly two
       * fifths of the fire's brightness at the same distance, and invisible.
       *
       * Focused beams are brighter as well as narrower: the same lamp, less
       * sky. Fire brightness is an accessibility control and the torch honours
       * it too, because the torch is the second brightest thing out here.
       */
      light.intensity = (30 + torch.focus * 44) * settings.fireBrightness;
      light.penumbra = 0.5;
    }

    if (body && torch.held) {
      body.position.set(handX, handY, handZ);
      body.lookAt(handX + dirX, handY + dirY, handZ + dirZ);
    }
  });

  return (
    <group name="torch">
      <spotLight
        ref={lightRef}
        color={0xffeccc}
        decay={1.4}
        castShadow={false}
        visible={false}
      />
      <object3D ref={targetRef} />
      {/* The torch itself, in the hand. Small, and mostly out of frame. */}
      {/* Aluminium rather than black plastic, with a floor under it.
          A dark-grey torch on a dark log in a dark camp is an invisible
          object, and the whole affordance is "pick the torch up off the log" —
          the same quantisation floor that makes an unlit surface render as
          nothing rather than as very dark (ARCHITECTURE §4.1). */}
      <mesh ref={bodyRef} geometry={bodyGeometry} castShadow>
        <meshStandardMaterial
          color={0x9aa5ae}
          emissive={0x1c2228}
          roughness={0.42}
          metalness={0.6}
        />
      </mesh>
    </group>
  );
}
