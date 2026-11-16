import React from 'react';
import { Composition } from 'remotion';
import { ProTeaser, TEASER_FRAMES } from './ProTeaser';
import { Brag, BRAG_FRAMES } from './Brag';

export const Root: React.FC = () => (
  <>
    <Composition id="ProTeaser" component={ProTeaser} durationInFrames={TEASER_FRAMES} fps={30} width={1080} height={1350} />
    <Composition id="Brag" component={Brag} durationInFrames={BRAG_FRAMES} fps={30} width={1920} height={1080} defaultProps={{ poster: false }} />
  </>
);
