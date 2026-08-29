/**
 * The torch.
 *
 * A real cone of light the player aims, and — because §12 says nothing may be
 * delivered through a single channel — a visible beam volume as well, so the
 * direction it is pointing is legible even to somebody who cannot make out the
 * pool of light on the ground.
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
}

export function Torch({ torch, player, settings }: TorchProps): React.ReactElement {
  const lightRef = useRef<THREE.SpotLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);
  const beamRef = useRef<THREE.Mesh>(null);
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

  /**
   * The visible beam.
   *
   * An open cone with no cap, drawn from the lens outward, additively blended
   * and very faint. This is dust in the air, which is the only reason a torch
   * beam is visible at all — and at 2am at a campsite there is always dust in
   * the air.
   */
  const beamGeometry = useMemo(() => {
    const geometry = new THREE.ConeGeometry(1, 1, 12, 1, true);
    // Cone points down by default; stand it along -Z and put the apex at 0.
    geometry.translate(0, -0.5, 0);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }, []);
  useEffect(() => () => beamGeometry.dispose(), [beamGeometry]);

  const beamMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xfff0cf,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => beamMaterial.dispose(), [beamMaterial]);

  useFrame(() => {
    const lit = torch.held && torch.on;

    const light = lightRef.current;
    const target = targetRef.current;
    const beam = beamRef.current;
    const body = bodyRef.current;

    if (body) body.visible = torch.held;
    if (beam) beam.visible = lit;
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
      // Focused beams are brighter as well as narrower: the same lamp, less
      // sky. Fire brightness is an accessibility control and the torch honours
      // it too, because the torch is the second brightest thing at a campsite.
      light.intensity = (5 + torch.focus * 9) * settings.fireBrightness;
      light.penumbra = 0.55;
    }

    if (beam) {
      const length = torch.rangeM * 0.82;
      const radius = Math.tan(torch.beamAngle) * length;
      beam.position.set(handX, handY, handZ);
      beam.scale.set(radius, radius, length);
      beam.lookAt(handX + dirX, handY + dirY, handZ + dirZ);
      // Faint, and fainter when it is focused: a narrow beam scatters less.
      beamMaterial.opacity = (0.05 + (1 - torch.focus) * 0.05) * settings.fireBrightness;
    }

    if (body) {
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
      <mesh ref={beamRef} geometry={beamGeometry} material={beamMaterial} visible={false} frustumCulled={false} />
      {/* The torch itself, in the hand. Small, and mostly out of frame. */}
      <mesh ref={bodyRef} geometry={bodyGeometry} visible={false}>
        <meshStandardMaterial color={0x2b2f33} roughness={0.7} metalness={0.3} />
      </mesh>
    </group>
  );
}
