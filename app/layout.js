import './globals.css';

export const metadata = {
  title: 'SG Map Viewer — Satellite + Land Lot',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
