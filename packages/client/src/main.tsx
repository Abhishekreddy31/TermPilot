import { render } from 'preact';
import { App } from './components/App.js';
import './styles/global.css';

render(<App />, document.getElementById('app')!);
