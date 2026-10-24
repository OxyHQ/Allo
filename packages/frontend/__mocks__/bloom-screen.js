/**
 * Bloom's Screen, stood in for under jest, for the reason `bloom-surfaces.js`
 * gives: the real one reaches `react-native-reanimated`, which this runner
 * cannot load. A Screen draws its children; the reader can see it.
 */
const React = require('react');

const Passthrough = ({ children }) => React.createElement(React.Fragment, null, children);

module.exports = {
  Screen: Passthrough,
  ScreenScrollView: Passthrough,
  useScreenVisible: () => true,
  useScreenBack: () => undefined,
  useScreenReselectHandler: () => undefined,
};
