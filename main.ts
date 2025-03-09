import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { S3Client, ListBucketsCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as JSZip from 'jszip';

// First, update your interface with the required settings
interface SyncFreeSettings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  
  bucketName: string;
  backupFrequency: number;  // in minutes
  enableAutoBackup: boolean;
  backupPath: string;  // optional subdirectory in the bucket
  excludeFolders: string;  // comma-separated list of folders to exclude
  availableBuckets: string[];  // List of available buckets from the account
  authToken: string;  // OAuth token for Cloudflare
}

const DEFAULT_SETTINGS: SyncFreeSettings = {
  accountId: '',
  accessKeyId: '',
  secretAccessKey: '',
  bucketName: '',
  backupFrequency: 60,  // Default to hourly backups
  enableAutoBackup: false,
  backupPath: '',
  excludeFolders: '.git,.obsidian/plugins,node_modules',
  availableBuckets: [],
  authToken: ''
}

export default class MyPlugin extends Plugin {
    settings: SyncFreeSettings;
    s3Client: S3Client | null = null;
    backupInterval: number | null = null;
    cloudflareOAuthWindow: Window | null = null;

    async onload() {
        await this.loadSettings();

        // This creates an icon in the left ribbon.
        const ribbonIconEl = this.addRibbonIcon('cloud-upload', 'SyncFree Backup', (evt: MouseEvent) => {
            // Called when the user clicks the icon.
            this.performBackup();
        });
        // Perform additional things with the ribbon
        ribbonIconEl.addClass('syncfree-ribbon-class');

        // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
        const statusBarItemEl = this.addStatusBarItem();
        statusBarItemEl.setText('SyncFree Ready');

        // Add a command to trigger backup
        this.addCommand({
            id: 'syncfree-backup-now',
            name: 'Backup vault to R2',
            callback: () => {
                this.performBackup();
            }
        });

        this.addSettingTab(new SyncFreeSettingTab(this.app, this));

        // Configure automatic backups if enabled
        this.configureAutomaticBackups();
    }

    onunload() {
        // Clear any scheduled backups
        if (this.backupInterval) {
            window.clearInterval(this.backupInterval);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // Reconfigure automatic backups when settings change
        this.configureAutomaticBackups();
    }

    /**
     * Configure or reconfigure automatic backups based on current settings
     */
    configureAutomaticBackups() {
        // Clear existing interval if any
        if (this.backupInterval) {
            window.clearInterval(this.backupInterval);
            this.backupInterval = null;
        }

        // Set up new interval if enabled
        if (this.settings.enableAutoBackup) {
            // Convert minutes to milliseconds
            const intervalMs = this.settings.backupFrequency * 60 * 1000;
            this.backupInterval = window.setInterval(() => {
                this.performBackup();
            }, intervalMs);
            
            console.log(`SyncFree: Automatic backups configured for every ${this.settings.backupFrequency} minutes`);
        } else {
            console.log('SyncFree: Automatic backups disabled');
        }
    }

    /**
     * Create or reuse an S3 client connection
     */
    getS3Client(): S3Client {
        if (!this.s3Client) {
            // Create new client
            this.s3Client = new S3Client({
                region: 'auto',
                endpoint: `https://${this.settings.accountId}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: this.settings.accessKeyId,
                    secretAccessKey: this.settings.secretAccessKey,
                },
            });
        }
        return this.s3Client;
    }

    /**
     * Test connection to R2 bucket
     */
    async testR2Connection(): Promise<boolean> {
        try {
            if (!this.settings.accountId || !this.settings.accessKeyId || 
                !this.settings.secretAccessKey || !this.settings.bucketName) {
                throw new Error('Please configure all required R2 settings first');
            }

            const s3Client = this.getS3Client();
            
            // Test bucket exists and is accessible
            const headBucketCommand = new HeadBucketCommand({
                Bucket: this.settings.bucketName
            });
            
            await s3Client.send(headBucketCommand);
            return true;
        } catch (error) {
            console.error('R2 connection test failed:', error);
            throw error;
        }
    }

    /**
     * Perform backup of the vault to R2
     */
    async performBackup(): Promise<void> {
        try {
            // First test connection
            await this.testR2Connection();
            
            const statusBarItem = this.addStatusBarItem();
            statusBarItem.setText('SyncFree: Backup in progress...');
            
            // Create a timestamp for the backup
            const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
            const backupFileName = `obsidian-backup-${timestamp}.zip`;
            
            // Create path for the backup in bucket
            const backupPath = this.settings.backupPath ? 
                `${this.settings.backupPath}/${backupFileName}`.replace(/\/+/g, '/') : 
                backupFileName;
            
            // Get files to backup
            const files = await this.getFilesToBackup();
            
            // Create a zip file
            const zip = new JSZip();
            
            // Add files to the zip
            for (const file of files) {
                const content = await this.app.vault.read(file);
                zip.file(file.path, content);
            }
            
            // Generate zip file
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            
            // Convert blob to ArrayBuffer for S3 upload
            const arrayBuffer = await zipBlob.arrayBuffer();
            
            // Upload to R2
            const s3Client = this.getS3Client();
            const putCommand = new PutObjectCommand({
                Bucket: this.settings.bucketName,
                Key: backupPath,
                Body: arrayBuffer,
                ContentType: 'application/zip',
            });
            
            await s3Client.send(putCommand);
            
            statusBarItem.setText('SyncFree: Backup complete');
            setTimeout(() => {
                statusBarItem.setText('SyncFree Ready');
            }, 5000);
            
            return;
        } catch (error) {
            console.error('Backup failed:', error);
            throw error;
        }
    }
    
    /**
     * Get all files to include in the backup
     */
    async getFilesToBackup(): Promise<TFile[]> {
        // Get all files in vault
        const files = this.app.vault.getFiles();
        
        // Parse exclude patterns
        const excludePatterns = this.settings.excludeFolders
            .split(',')
            .map(pattern => pattern.trim())
            .filter(pattern => pattern);
        
        // Filter files based on exclude patterns
        return files.filter(file => {
            // Check if the file path starts with any of the excluded folder paths
            return !excludePatterns.some(pattern => {
                return file.path.startsWith(pattern);
            });
        });
    }

    /**
     * Initiate Cloudflare OAuth flow
     */
    async initiateCloudflareAuth(): Promise<void> {
        // Cloudflare OAuth application configuration
        // You'll need to register an OAuth application in Cloudflare
        const clientId = '1571c322fff79945c3347586c851d6c7.access';
        const redirectUri = 'https://your-plugin-redirect-handler.com/callback';
        const responseType = 'token';
        const scope = 'r2:admin';
        
        // Generate a random state value to prevent CSRF
        const state = Math.random().toString(36).substring(2);
        
        // Store state for verification on callback
        this.settings.oauthState = state;
        await this.saveSettings();
        
        // Build the OAuth URL
        const authUrl = new URL('https://dash.cloudflare.com/oauth2/auth');
        authUrl.searchParams.append('client_id', clientId);
        authUrl.searchParams.append('redirect_uri', redirectUri);
        authUrl.searchParams.append('response_type', responseType);
        authUrl.searchParams.append('scope', scope);
        authUrl.searchParams.append('state', state);
        
        // Open a popup window for the auth flow
        this.cloudflareOAuthWindow = window.open(
            authUrl.toString(),
            'CloudflareAuth',
            'width=800,height=600,menubar=no'
        );
        
        // Listen for messages from the OAuth redirect page
        window.addEventListener('message', this.handleOAuthCallback.bind(this), false);
        
        new Notice('Please authenticate with Cloudflare in the opened window');
    }
    
    /**
     * Handle OAuth callback with the auth token
     */
    async handleOAuthCallback(event: MessageEvent): Promise<void> {
        // Ensure the message is from our expected source
        if (event.origin !== 'https://syncfree.arnabbhowmik019.workers.dev/callback') {
            return;
        }
        
        // Close the auth window
        if (this.cloudflareOAuthWindow) {
            this.cloudflareOAuthWindow.close();
            this.cloudflareOAuthWindow = null;
        }
        
        try {
            const { token, state } = event.data;
            
            // Verify state matches to prevent CSRF
            if (state !== this.settings.oauthState) {
                throw new Error('OAuth state mismatch. Authentication failed.');
            }
            
            // Save the token
            this.settings.authToken = token;
            await this.saveSettings();
            
            // Fetch account info
            await this.fetchCloudflareAccountInfo();
            
            // Get available buckets
            await this.fetchAvailableBuckets();
            
            new Notice('Successfully connected to Cloudflare!');
        } catch (error) {
            console.error('OAuth callback error:', error);
            new Notice(`Authentication failed: ${error.message}`);
        }
    }
    
    /**
     * Fetch Cloudflare account information using the OAuth token
     */
    async fetchCloudflareAccountInfo(): Promise<void> {
        try {
            if (!this.settings.authToken) {
                throw new Error('Not authenticated with Cloudflare');
            }
            
            const response = await fetch('https://api.cloudflare.com/client/v4/accounts', {
                headers: {
                    'Authorization': `Bearer ${this.settings.authToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`Cloudflare API error: ${response.status}`);
            }
            
            const data = await response.json();
            if (data.result && data.result.length > 0) {
                // Update account ID
                this.settings.accountId = data.result[0].id;
                await this.saveSettings();
            } else {
                throw new Error('No Cloudflare accounts found');
            }
        } catch (error) {
            console.error('Failed to fetch account info:', error);
            throw error;
        }
    }
    
    /**
     * Create API tokens for R2 access instead of using OAuth token directly
     */
    async createR2ApiTokens(): Promise<void> {
        try {
            if (!this.settings.authToken || !this.settings.accountId) {
                throw new Error('Not properly authenticated with Cloudflare');
            }
            
            // This is a placeholder for the actual API call to create R2 tokens
            // The exact endpoint will depend on Cloudflare's API
            const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/r2/tokens`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.settings.authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: 'SyncFree Obsidian Plugin',
                    permissions: {
                        read: true,
                        write: true
                    }
                })
            });
            
            if (!response.ok) {
                throw new Error(`Failed to create R2 API tokens: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Update settings with the new tokens
            this.settings.accessKeyId = data.result.key_id;
            this.settings.secretAccessKey = data.result.secret;
            
            // Reset the S3 client to use the new credentials
            this.s3Client = null;
            
            await this.saveSettings();
            
            new Notice('R2 API tokens created successfully');
        } catch (error) {
            console.error('Failed to create R2 API tokens:', error);
            throw error;
        }
    }
    
    /**
     * Fetch available R2 buckets for the account
     */
    async fetchAvailableBuckets(): Promise<void> {
        try {
            // First ensure we have valid credentials
            if (!this.settings.accessKeyId || !this.settings.secretAccessKey) {
                await this.createR2ApiTokens();
            }
            
            // Get S3 client
            const s3Client = this.getS3Client();
            
            // List buckets
            const command = new ListBucketsCommand({});
            const response = await s3Client.send(command);
            
            if (response.Buckets && response.Buckets.length > 0) {
                // Update available buckets in settings
                this.settings.availableBuckets = response.Buckets.map(bucket => bucket.Name || '');
                await this.saveSettings();
            } else {
                this.settings.availableBuckets = [];
                await this.saveSettings();
                
                new Notice('No R2 buckets found in your account. Please create a bucket first.');
            }
        } catch (error) {
            console.error('Failed to fetch buckets:', error);
            throw error;
        }
    }
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SyncFreeSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    
    containerEl.createEl('h2', {text: 'SyncFree - R2 Cloudflare Backup Settings'});
    
    // Add OAuth connection button at the top
    new Setting(containerEl)
      .setName('Connect with Cloudflare')
      .setDesc('Authenticate directly with your Cloudflare account')
      .addButton(button => button
        .setButtonText('Connect to Cloudflare')
        .setCta()
        .onClick(async () => {
          try {
            await this.plugin.initiateCloudflareAuth();
          } catch (error) {
            console.error('Cloudflare authentication error:', error);
            new Notice(`Authentication failed: ${error.message}`);
          }
        }));
    
    // If auth token exists, show disconnect button
    if (this.plugin.settings.authToken) {
      new Setting(containerEl)
        .setName('Connected Account')
        .setDesc(`Account ID: ${this.plugin.settings.accountId || 'Unknown'}`)
        .addButton(button => button
          .setButtonText('Disconnect')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.authToken = '';
            await this.plugin.saveSettings();
            // Redisplay settings
            this.display();
            new Notice('Disconnected from Cloudflare account');
          }));
    }
    
    // If we have buckets and we're authenticated, show bucket selector
    if (this.plugin.settings.authToken && 
        this.plugin.settings.availableBuckets && 
        this.plugin.settings.availableBuckets.length > 0) {
          
      new Setting(containerEl)
        .setName('Select Bucket')
        .setDesc('Choose which R2 bucket to use for backups')
        .addDropdown(dropdown => {
          // Add empty option
          dropdown.addOption('', 'Select a bucket');
          
          // Add all buckets
          this.plugin.settings.availableBuckets.forEach(bucket => {
            dropdown.addOption(bucket, bucket);
          });
          
          // Set current selection
          dropdown.setValue(this.plugin.settings.bucketName);
          
          // Handle selection change
          dropdown.onChange(async (value) => {
            this.plugin.settings.bucketName = value;
            await this.plugin.saveSettings();
          });
        });
        
      // Add refresh buckets button
      new Setting(containerEl)
        .setName('Refresh Buckets')
        .setDesc('Update the list of available buckets')
        .addButton(button => button
          .setButtonText('Refresh')
          .onClick(async () => {
            try {
              await this.plugin.fetchAvailableBuckets();
              // Redisplay to update the dropdown
              this.display();
              new Notice('Bucket list refreshed');
            } catch (error) {
              console.error('Failed to refresh buckets:', error);
              new Notice(`Error refreshing buckets: ${error.message}`);
            }
          }));
    }
    
    // Show manual credential fields for advanced users or as fallback
    containerEl.createEl('h3', {text: 'Manual Configuration'});
    containerEl.createEl('p', {
      text: 'You can either connect directly with Cloudflare above or manually enter your credentials below.',
      cls: 'setting-item-description'
    });
    
    new Setting(containerEl)
      .setName('Cloudflare Account ID')
      .setDesc('Your Cloudflare account ID')
      .addText(text => text
        .setPlaceholder('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
        .setValue(this.plugin.settings.accountId)
        .onChange(async (value) => {
          this.plugin.settings.accountId = value;
          await this.plugin.saveSettings();
        }));
        
    new Setting(containerEl)
      .setName('R2 Access Key ID')
      .setDesc('Your R2 access key ID')
      .addText(text => text
        .setPlaceholder('Access Key ID')
        .setValue(this.plugin.settings.accessKeyId)
        .onChange(async (value) => {
          this.plugin.settings.accessKeyId = value;
          await this.plugin.saveSettings();
        }));
        
    new Setting(containerEl)
      .setName('R2 Secret Access Key')
      .setDesc('Your R2 secret access key')
      .addText(text => text
        .setPlaceholder('Secret Access Key')
        .setValue(this.plugin.settings.secretAccessKey)
        .onChange(async (value) => {
          this.plugin.settings.secretAccessKey = value;
          await this.plugin.saveSettings();
        })
        .inputEl.type = 'password');
        
    new Setting(containerEl)
      .setName('Bucket Name')
      .setDesc('Name of your R2 bucket for backups')
      .addText(text => text
        .setPlaceholder('my-obsidian-backups')
        .setValue(this.plugin.settings.bucketName)
        .onChange(async (value) => {
          this.plugin.settings.bucketName = value;
          await this.plugin.saveSettings();
        }));
        
    containerEl.createEl('h3', {text: 'Backup Configuration'});
        
    new Setting(containerEl)
      .setName('Backup Path (Optional)')
      .setDesc('Subdirectory within the bucket to store backups (e.g., obsidian/vault-name)')
      .addText(text => text
        .setPlaceholder('obsidian/vault-name')
        .setValue(this.plugin.settings.backupPath)
        .onChange(async (value) => {
          this.plugin.settings.backupPath = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName('Enable Automatic Backups')
      .setDesc('Automatically backup your vault based on the frequency set')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAutoBackup)
        .onChange(async (value) => {
          this.plugin.settings.enableAutoBackup = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName('Backup Frequency (minutes)')
      .setDesc('How often to perform automatic backups')
      .addSlider(slider => slider
        .setLimits(15, 1440, 15)
        .setValue(this.plugin.settings.backupFrequency)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.backupFrequency = value;
          await this.plugin.saveSettings();
        }));
        
    new Setting(containerEl)
      .setName('Exclude Folders')
      .setDesc('Comma-separated list of folders to exclude from backup')
      .addTextArea(text => text
        .setPlaceholder('.git,.obsidian/plugins,node_modules')
        .setValue(this.plugin.settings.excludeFolders)
        .onChange(async (value) => {
          this.plugin.settings.excludeFolders = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('div', { text: 'Manual Backup', cls: 'setting-item-heading' });
    
    new Setting(containerEl)
      .setName('Backup Now')
      .setDesc('Manually trigger a backup to your R2 bucket')
      .addButton(button => button
        .setButtonText('Backup Now')
        .setCta()
        .onClick(async () => {
          new Notice('Starting backup to R2...');
          try {
            // This function needs to be implemented in your MyPlugin class
            await this.plugin.performBackup();
            new Notice('Backup completed successfully!');
          } catch (error) {
            console.error('Backup error:', error);
            new Notice(`Backup failed: ${error.message || 'Unknown error'}`);
          }
        }));
        
    new Setting(containerEl)
      .setName('Connection Test')
      .setDesc('Test your R2 bucket connection')
      .addButton(button => button
        .setButtonText('Test Connection')
        .onClick(async () => {
          new Notice('Testing connection to R2...');
          try {
            // This function needs to be implemented in your MyPlugin class
            await this.plugin.testR2Connection();
            new Notice('Connection successful! Your R2 bucket is accessible.');
          } catch (error) {
            console.error('Connection test error:', error);
            new Notice(`Connection failed: ${error.message || 'Unknown error'}`);
          }
        }));
  }
}
