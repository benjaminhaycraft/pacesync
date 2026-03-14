# PaceSync – Trail Running Playlist Generator

A production-ready, single-file HTML application that generates Spotify playlists matched to your running pace and trail elevation profile.

## Features

### Core Functionality
- **Spotify OAuth PKCE Integration**: Secure authentication with no backend required
- **8 Pre-configured French Trails**: Well-known trail runs with realistic elevation profiles
- **GPX File Import**: Upload your own trail GPX files for custom playlist generation
- **Real-time BPM Calculation**: Matches music tempo to running pace and terrain gradient
- **Three Target Modes**: 
  - Target Pace (min/km)
  - Distance + Time
  - Target Time (hours + minutes)

### Spotify Integration
- Create playlists directly in your Spotify account
- Real-time recommendations using Spotify's recommendations API
- Audio feature analysis for accurate BPM matching
- Token refresh for persistent authentication

### GPX Support
- Parse GPX files with elevation data
- Calculate trail distance using Haversine formula
- Compute elevation gain automatically
- Resample elevation profiles for consistent analysis

### Visual Design
- Dark theme optimized for trail running community
- Interactive elevation charts with color-coded terrain
- Responsive layout (mobile-friendly)
- Real-time playlist preview with BPM assignments
- Polished UI with gradient accents and smooth animations

## Technical Stack

- **React 18**: Via CDN (no build step required)
- **Babel Standalone**: JSX transpilation in the browser
- **Spotify Web API**: For playlist creation and track recommendations
- **SVG Charts**: Custom elevation visualization
- **localStorage**: Persistent token storage for OAuth flow

## File Paths

- **Main Application**: `/sessions/tender-sharp-fermat/mnt/outputs/index.html`
- **File Size**: ~1.8MB (entire app self-contained)

## Key Algorithms

### BPM Calculation
```javascript
// Base BPM from pace: 220 - (min/km * 15)
// Gradient adjustment:
// - Uphill: -250 BPM per gradient unit
// - Downhill: +200 BPM per gradient unit
// - Clamped: 95–180 BPM range
```

### Trail Data
- **8 French Trails** with verified distances, elevation gains, and realistic profiles
- Difficulty classifications: Easy, Medium, Hard
- Support for both predefined and custom GPX trails

## Deployment

This is a single HTML file ready for GitHub Pages or any static hosting:
1. Upload `/index.html` to your web server
2. Configure Spotify OAuth redirect URI to match your domain
3. No backend, build process, or dependencies required

## Browser Compatibility

- Modern browsers with ES6+ support
- Requires `crypto.subtle` for PKCE SHA-256 hashing
- Works on desktop and mobile devices

## Credits

Built for the trail running community with Spotify integration.
