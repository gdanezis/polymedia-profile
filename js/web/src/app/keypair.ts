import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/* Private Key and Keypair Management */

const PRIVATE_KEY_STORAGE_KEY = 'polymedia-profile-private-key';

const generatePrivateKey = (): string => {
	// Generate a new Ed25519 keypair and extract its private key
	const randomKeypair = new Ed25519Keypair();
	return randomKeypair.getSecretKey();
};

const getPrivateKeyFromStorage = (): string | null => {
	try {
		const secretKey = localStorage.getItem(PRIVATE_KEY_STORAGE_KEY);
		// Validate that we have a valid private key string
		if (secretKey && secretKey.length > 0) {
			return secretKey;
		}
		return null;
	} catch (error) {
		console.warn('[getPrivateKeyFromStorage] Failed to read secret key from storage:', error);
		return null;
	}
};

const savePrivateKeyToStorage = (secretKey: string): void => {
	try {
		localStorage.setItem(PRIVATE_KEY_STORAGE_KEY, secretKey);
		console.debug('[savePrivateKeyToStorage] Secret key saved to storage successfully');
	} catch (error) {
		console.warn('[savePrivateKeyToStorage] Failed to save secret key to storage:', error);
	}
};

export const initializeKeypair = (): Ed25519Keypair => {
	let secretKey = getPrivateKeyFromStorage();
	
	if (!secretKey) {
		secretKey = generatePrivateKey();
		savePrivateKeyToStorage(secretKey);
		console.debug('[initializeKeypair] Generated new secret key and saved to storage');
	} else {
		console.debug('[initializeKeypair] Loaded existing secret key from storage');
	}
	
	try {
		const keypair = Ed25519Keypair.fromSecretKey(secretKey);
		const address = keypair.getPublicKey().toSuiAddress();
		console.debug('[initializeKeypair] Created keypair with address:', address);
		return keypair;
	} catch (error) {
		console.warn('[initializeKeypair] Failed to create keypair from stored secret key, generating new one:', error);
		// If the stored secret key is invalid, generate a new one
		secretKey = generatePrivateKey();
		savePrivateKeyToStorage(secretKey);
		const keypair = Ed25519Keypair.fromSecretKey(secretKey);
		const address = keypair.getPublicKey().toSuiAddress();
		console.debug('[initializeKeypair] Generated new keypair with address:', address);
		return keypair;
	}
};
