import { NativeModule, requireNativeModule } from 'expo';

import type { LocalAddress } from './LinkNet.types';

declare class LinkNetModule extends NativeModule<{}> {
  /** Toutes les adresses IPv4 locales actives (hors loopback). */
  getLocalAddresses(): LocalAddress[];
}

export default requireNativeModule<LinkNetModule>('LinkNet');
