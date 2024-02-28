/**
 * @author Kuitos
 * @since 2020-03-02
 */

import { concat, mergeWith } from 'lodash';
import getEngineFlagAddon from './engineFlag';
import getRuntimePublicPathAddOn from './runtimePublicPath';

export default function getAddOns(global, publicPath) {
  return mergeWith({}, getEngineFlagAddon(global), getRuntimePublicPathAddOn(global, publicPath), (v1, v2) =>
    concat(v1 ?? [], v2 ?? []),
  );
}
