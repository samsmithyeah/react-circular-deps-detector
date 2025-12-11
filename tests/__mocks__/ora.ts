const mockSpinner = {
  start: jest.fn().mockReturnThis(),
  stop: jest.fn().mockReturnThis(),
  succeed: jest.fn().mockReturnThis(),
  fail: jest.fn().mockReturnThis(),
  warn: jest.fn().mockReturnThis(),
  info: jest.fn().mockReturnThis(),
  text: '',
  color: 'cyan' as const,
  spinner: 'dots' as const,
  isSpinning: false,
};

const ora = jest.fn(() => mockSpinner);

export default ora;
